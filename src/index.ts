/**
 * tencentcloud-agentobs-sdk-pi
 *
 * 两种接入方式：
 *  1. 作为 Pi 扩展自动加载（pi install / ~/.pi/agent/extensions / settings.json），入口 ./extension
 *  2. SDK 内嵌：new DefaultResourceLoader({ extensionFactories: [createAgentObsExtension({...})] })
 */
import { type AgentObsOptions, type ResolvedConfig, resolveConfig } from "./config.ts";
import { createExporter, type Logger, type SpanExporter, stderrLogger } from "./exporters.ts";
import { type MinimalCtx, PiTracer } from "./tracer.ts";

export type { AgentObsOptions, ResolvedConfig } from "./config.ts";
export { normalizeEndpoint, resolveConfig } from "./config.ts";
export { ClsExporter, ConsoleExporter, MemoryExporter, NoopExporter, type SpanExporter } from "./exporters.ts";
export { OtlpExporter, toReadableSpan } from "./otlp.ts";
export type { CLSSpan } from "./span.ts";
export { PiTracer } from "./tracer.ts";
export { VERSION } from "./version.ts";

export interface CreateExtensionOptions extends AgentObsOptions {
	/** 自定义导出器（测试或自建管道）；不传则按配置创建并在进程内共享 */
	spanExporter?: SpanExporter;
	logger?: Logger;
}

/**
 * 进程级共享状态放在 globalThis 上：同一份扩展可能被 jiti 以不同模块实例加载多次
 * （例如既在 ~/.pi/agent/extensions 又在 settings.json packages 里），模块级变量无法去重。
 */
interface GlobalState {
	/** 按导出目标指纹共享：同一目标只建一个队列/连接，不同目标（不同 topic/endpoint/文件）互不干扰 */
	exporters: Map<string, SpanExporter>;
	/** sessionId → 拥有该会话采集权的扩展实例 id */
	owners: Map<string, string>;
	nextInstance: number;
	warned: boolean;
	exitHooked: boolean;
}
const GLOBAL_KEY = Symbol.for("tencentcloud.agentobs.pi");
function globalState(): GlobalState {
	const g = globalThis as any;
	g[GLOBAL_KEY] ??= { exporters: new Map(), owners: new Map(), nextInstance: 1, warned: false, exitHooked: false } satisfies GlobalState;
	return g[GLOBAL_KEY];
}

function exporterKey(c: ResolvedConfig): string {
	switch (c.exporter) {
		case "cls":
			return `cls|${c.endpoint}|${c.topicId}|${c.secretId || `uin:${c.uin}`}`;
		case "otlp":
			return `otlp|${c.otlpProtocol}|${c.otlpEndpoint ?? "env"}|${JSON.stringify(c.otlpHeaders ?? null)}|${c.serviceName}`;
		case "console":
			return `console|${c.consoleFile}`;
		default:
			return "none";
	}
}

/** 结构化最小 ExtensionAPI，避免运行时依赖 pi 包（类型由 peerDependency 提供） */
export interface PiLike {
	on(event: string, handler: (event: any, ctx: any) => unknown): unknown;
	getActiveTools?: () => string[];
	getAllTools?: () => Array<{ name: string; description?: string; parameters?: unknown }>;
}

export function createAgentObsExtension(options: CreateExtensionOptions = {}) {
	return function agentObsExtension(pi: PiLike): void {
		const config = resolveConfig(options);
		const logger = options.logger ?? stderrLogger;
		if (!config.enabled) return;
		const g = globalState();
		if ((config.missing.length > 0 || config.warnings.length > 0) && !g.warned) {
			g.warned = true;
			if (config.missing.length > 0) logger.warn(`[agentobs-pi] CLS 配置不完整，已降级为 none，缺少：${config.missing.join(", ")}`);
			for (const w of config.warnings) logger.warn(`[agentobs-pi] ${w}`);
		}
		let exporter = options.spanExporter;
		if (!exporter) {
			const key = exporterKey(config);
			exporter = g.exporters.get(key);
			if (!exporter) {
				exporter = createExporter(config, logger);
				g.exporters.set(key, exporter);
			}
			if (!g.exitHooked) {
				g.exitHooked = true;
				process.once("beforeExit", () => {
					for (const e of g.exporters.values()) void e.shutdown();
				});
			}
		}

		const instanceId = `i${g.nextInstance++}`;
		const tracer = new PiTracer(config, exporter, {
			getToolDefinitions: () => {
				const active = new Set(pi.getActiveTools?.() ?? []);
				return (pi.getAllTools?.() ?? [])
					.filter((t) => active.has(t.name))
					.map((t) => ({ type: "function", name: t.name, description: t.description ?? null, parameters: t.parameters }));
			},
		});

		/** 同一会话只允许一个本扩展实例采集（先到先得），避免重复加载导致双份 span */
		const owns = (ctx: MinimalCtx): boolean => {
			const sid = ctx?.sessionManager?.getSessionId?.();
			if (!sid) return false;
			const owner = g.owners.get(sid);
			if (owner === undefined) {
				g.owners.set(sid, instanceId);
				if (config.debug) logger.info(`[agentobs-pi] ${instanceId} owns session ${sid}`);
				return true;
			}
			return owner === instanceId;
		};

		const guard =
			(name: string, fn: (e: any, ctx: MinimalCtx) => unknown) =>
			(e: any, ctx: MinimalCtx): undefined => {
				try {
					if (owns(ctx)) {
						const r = fn(e, ctx);
						if (r instanceof Promise) r.catch((err) => logger.warn(`[agentobs-pi] ${name} failed: ${err}`));
					}
				} catch (err) {
					logger.warn(`[agentobs-pi] ${name} failed: ${err}`);
				}
				// 永远返回 undefined：不修改 payload、不覆盖 cache warming 决策
				return undefined;
			};

		pi.on("before_agent_start", guard("before_agent_start", (e, c) => tracer.onBeforeAgentStart(e, c)));
		pi.on("agent_start", guard("agent_start", (_e, c) => tracer.onAgentStart(c)));
		pi.on("turn_start", guard("turn_start", (e, c) => tracer.onTurnStart(e, c)));
		pi.on("context", guard("context", (_e, c) => tracer.onContext(c)));
		pi.on("before_provider_headers", guard("before_provider_headers", (e, c) => tracer.onBeforeProviderHeaders(e, c)));
		pi.on("before_provider_request", guard("before_provider_request", (e, c) => tracer.onBeforeProviderRequest(e, c)));
		pi.on("after_provider_response", guard("after_provider_response", (e, c) => tracer.onAfterProviderResponse(e, c)));
		pi.on("message_start", guard("message_start", (e, c) => tracer.onMessageStart(e, c)));
		pi.on("message_update", guard("message_update", (e, c) => tracer.onMessageUpdate(e, c)));
		pi.on("message_end", guard("message_end", (e, c) => tracer.onMessageEnd(e, c)));
		pi.on("tool_execution_start", guard("tool_execution_start", (e, c) => tracer.onToolExecutionStart(e, c)));
		pi.on("tool_execution_end", guard("tool_execution_end", (e, c) => tracer.onToolExecutionEnd(e, c)));
		pi.on("turn_end", guard("turn_end", (_e, c) => tracer.onTurnEnd(c)));
		pi.on("agent_end", guard("agent_end", (_e, c) => tracer.onAgentEnd(c)));
		pi.on("agent_settled", guard("agent_settled", (e, c) => tracer.onAgentSettled(e, c)));
		// session_shutdown 需要 await flush，单独处理
		pi.on("session_shutdown", async (_e: any, ctx: MinimalCtx) => {
			try {
				if (!owns(ctx)) return;
				await tracer.onSessionShutdown(ctx);
				g.owners.delete(ctx.sessionManager.getSessionId());
			} catch (err) {
				logger.warn(`[agentobs-pi] session_shutdown failed: ${err}`);
			}
		});
	};
}
