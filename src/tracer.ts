/**
 * Pi 扩展事件 → CLS 5 层 span（entry → agent → step → chat / tool）。
 *
 * 事件时序（在 pi-coding-agent@1.3.0 上用 mock LLM 实测，见 test/e2e/probe.ts）：
 *   before_agent_start → agent_start → turn_start → message_end(user) → context
 *   → before_provider_headers → before_provider_request → after_provider_response
 *   → message_start/update/end(assistant) → tool_execution_start/end … → turn_end
 *   → agent_end → [agent 级自动重试：再来一轮 agent_start…agent_end] → agent_settled
 *
 * 设计要点（每条都对应一个实测现象）：
 *  1. entry/agent 用 before_agent_start → agent_settled 包住，而不是 agent_start/agent_end：
 *     agent 级重试时 agent_start/agent_end 会成对出现多次，但 before_agent_start/agent_settled 只各一次。
 *  2. chat span 只为“agent 请求”创建：其前面必有 context 事件。cache warming 请求
 *     （cache_warming_decision → headers → request → response，没有 context、没有 message_end）不建 span，
 *     否则会产生永远不结束的孤儿 span。
 *  3. chat span 在 before_provider_headers（早于 before_provider_request）时开始，traceparent 才能注入；
 *     两者之差记为 pi.request.prepare_ms（首个请求包含 provider SDK 懒加载耗时，实测 ~9s），
 *     因此 TTFT 从 before_provider_request 起算，避免把本地冷启动算成模型首包延迟。
 *  4. HTTP 非 2xx 时没有 after_provider_response，状态码只能从 assistant.errorMessage 前缀解析。
 *  5. provider 级重试（retry.provider.maxRetries）对扩展不可见：多次 HTTP 只对应一次 request 事件。
 *  6. 工具默认并行执行，start/end 交错，按 toolCallId 管理，不能用栈。
 *  7. usage.input 已扣除 cacheRead，按 semconv 上报 input_tokens = input + cacheRead + cacheWrite。
 */
import { performance } from "node:perf_hooks";
import type { ResolvedConfig } from "./config.ts";
import type { SpanExporter } from "./exporters.ts";
import { type GenAIMessage, mapAgentMessage, mapContent, mapFinishReason, mapToolResult } from "./messages.ts";
import { type AttrValue, buildSpan, getLocalIp, newSpanId, newTraceId, safeStringify, truncate } from "./span.ts";
import { VERSION } from "./version.ts";

/** 只依赖扩展上下文里用到的最小结构，避免运行时依赖 pi 包 */
export interface MinimalCtx {
	sessionManager: { getSessionId(): string };
	model?: { id?: string; provider?: string; api?: string } | undefined;
	cwd?: string;
}

interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
}

interface ChatState {
	spanId: string;
	parentSpanId: string;
	stepSeq: number;
	startMs: number;
	startMono: number;
	firstMono?: number;
	headersSeen: boolean;
	requestSeen: boolean;
	requestMs?: number;
	/** before_provider_request 的单调时钟；TTFT 从这里算，排除 provider SDK 懒加载等本地准备耗时 */
	requestMono?: number;
	provider?: string;
	model?: string;
	api?: string;
	httpStatus?: number;
	requestId?: string;
	maxTokens?: number;
	temperature?: number;
	inputs: GenAIMessage[];
	foreignTraceparent?: boolean;
}

interface ToolState {
	spanId: string;
	parentSpanId: string;
	stepSeq: number;
	name: string;
	callId: string;
	args: unknown;
	startMs: number;
}

interface StepState {
	spanId: string;
	seq: number;
	turnIndex: number;
	attempt: number;
	startMs: number;
	lastStop?: string;
}

interface EntryState {
	seq: number;
	traceId: string;
	entrySpanId: string;
	agentSpanId: string;
	startMs: number;
	inputs: GenAIMessage[];
	context: GenAIMessage[];
	finalOutput?: GenAIMessage;
	usage: Usage;
	attempts: number;
	stepSeq: number;
	step?: StepState;
	chat?: ChatState;
	tools: Map<string, ToolState>;
	assistantStartMs?: number;
	lastStop?: string;
	lastError?: string;
	model?: string;
	provider?: string;
	llmCalls: number;
	toolCalls: number;
	toolErrors: number;
}

interface SessionState {
	sid: string;
	cwd?: string;
	promptSeq: number;
	pendingAgentRequest: boolean;
	systemPrompt?: string;
	entry?: EntryState;
}

const VISIBLE_DELTAS = new Set(["text_delta", "thinking_delta", "toolcall_start", "toolcall_delta"]);
const REQUEST_ID_HEADERS = ["x-request-id", "request-id", "x-tc-requestid", "x-acs-request-id", "apim-request-id", "cf-ray"];

export interface TracerHooks {
	/** 返回当前活跃工具定义（用于 gen_ai.tool.definitions），可选 */
	getToolDefinitions?: () => unknown[];
}

export class PiTracer {
	private readonly sessions = new Map<string, SessionState>();
	private readonly host = getLocalIp();
	private readonly instanceId: string;
	private readonly config: ResolvedConfig;
	private readonly exporter: SpanExporter;
	private readonly hooks: TracerHooks;

	constructor(config: ResolvedConfig, exporter: SpanExporter, hooks: TracerHooks = {}) {
		this.config = config;
		this.exporter = exporter;
		this.hooks = hooks;
		this.instanceId = `${config.serviceName}@${this.host}:${process.pid}`;
	}

	// ───────────────────────────── 生命周期事件 ─────────────────────────────

	onBeforeAgentStart(e: any, ctx: MinimalCtx): void {
		const s = this.session(ctx);
		if (s.entry) this.closeEntry(s, { code: "INTERRUPTED", message: "new run started before previous settled" });
		this.openEntry(s);
		if (typeof e?.systemPrompt === "string") s.systemPrompt = e.systemPrompt;
		if (e?.messageType === "user" && s.entry) {
			const parts = [{ type: "text", content: String(e.prompt ?? "") }, ...mapContent(e.images ?? [])];
			s.entry.inputs.push({ role: "user", parts });
		} else if (e?.messageType === "custom" && s.entry) {
			s.entry.inputs.push({ role: "user", parts: mapContent(e.message?.content) });
		}
	}

	onAgentStart(ctx: MinimalCtx): void {
		const s = this.session(ctx);
		if (!s.entry) this.openEntry(s); // 没有 before_agent_start 的运行（如排队消息续跑）
		s.entry!.attempts++;
	}

	onTurnStart(e: any, ctx: MinimalCtx): void {
		const entry = this.session(ctx).entry;
		if (!entry) return;
		if (entry.step) this.closeStep(this.session(ctx), entry);
		entry.step = { spanId: newSpanId(), seq: ++entry.stepSeq, turnIndex: Number(e?.turnIndex ?? 0), attempt: entry.attempts, startMs: Date.now() };
	}

	onContext(ctx: MinimalCtx): void {
		const s = this.session(ctx);
		if (s.entry) s.pendingAgentRequest = true;
	}

	onBeforeProviderHeaders(e: any, ctx: MinimalCtx): void {
		const s = this.session(ctx);
		const entry = s.entry;
		if (!entry) return;
		let chat: ChatState | undefined;
		if (s.pendingAgentRequest) chat = this.ensureChat(s, entry, ctx);
		else if (entry.chat && !entry.chat.headersSeen) chat = entry.chat; // 先 request 后 headers 的 provider
		if (!chat) return;
		chat.headersSeen = true;
		if (this.config.propagateTraceparent && e?.headers && typeof e.headers === "object") {
			const hasForeign = Object.keys(e.headers).some((k) => k.toLowerCase() === "traceparent" && e.headers[k]);
			if (hasForeign) chat.foreignTraceparent = true;
			else e.headers.traceparent = `00-${entry.traceId}-${chat.spanId}-01`;
		}
	}

	onBeforeProviderRequest(e: any, ctx: MinimalCtx): void {
		const s = this.session(ctx);
		const entry = s.entry;
		if (!entry || !s.pendingAgentRequest) return; // cache warming 等辅助请求
		const chat = this.ensureChat(s, entry, ctx);
		s.pendingAgentRequest = false;
		chat.requestSeen = true;
		chat.requestMs = Date.now();
		chat.requestMono = performance.now();
		const p = e?.payload;
		if (p && typeof p === "object") {
			const mt = p.max_completion_tokens ?? p.max_tokens ?? p.max_output_tokens ?? p.generationConfig?.maxOutputTokens;
			if (typeof mt === "number") chat.maxTokens = mt;
			const t = p.temperature ?? p.generationConfig?.temperature;
			if (typeof t === "number") chat.temperature = t;
		}
	}

	onAfterProviderResponse(e: any, ctx: MinimalCtx): void {
		const chat = this.session(ctx).entry?.chat;
		if (!chat || !chat.requestSeen || chat.httpStatus !== undefined) return;
		chat.httpStatus = Number(e?.status);
		const headers = (e?.headers ?? {}) as Record<string, string>;
		for (const h of REQUEST_ID_HEADERS) {
			const v = headers[h] ?? headers[h.toLowerCase()];
			if (v) {
				chat.requestId = String(v);
				break;
			}
		}
	}

	onMessageStart(e: any, ctx: MinimalCtx): void {
		const entry = this.session(ctx).entry;
		if (entry && e?.message?.role === "assistant") entry.assistantStartMs = Date.now();
	}

	onMessageUpdate(e: any, ctx: MinimalCtx): void {
		const chat = this.session(ctx).entry?.chat;
		if (chat && chat.firstMono === undefined && VISIBLE_DELTAS.has(e?.assistantMessageEvent?.type)) chat.firstMono = performance.now();
	}

	onMessageEnd(e: any, ctx: MinimalCtx): void {
		const s = this.session(ctx);
		const entry = s.entry;
		const msg = e?.message;
		if (!entry || !msg) return;
		const mapped = mapAgentMessage(msg);
		if (mapped) entry.context.push(mapped);
		if (msg.role !== "assistant") return;

		// 没走 onPayload 钩子的自定义 provider：用 message_start 时间合成一个 chat span
		let chat = entry.chat;
		if (!chat) {
			chat = this.newChat(s, entry, ctx, entry.assistantStartMs ?? Date.now());
			s.pendingAgentRequest = false;
		}
		entry.chat = undefined;
		entry.assistantStartMs = undefined;
		entry.llmCalls++;
		entry.lastStop = msg.stopReason;
		entry.lastError = msg.errorMessage;
		entry.model = msg.model ?? entry.model;
		entry.provider = msg.provider ?? entry.provider;
		if (entry.step) entry.step.lastStop = msg.stopReason;
		const u = msg.usage ?? {};
		const usage: Usage = {
			input: Number(u.input ?? 0),
			output: Number(u.output ?? 0),
			cacheRead: Number(u.cacheRead ?? 0),
			cacheWrite: Number(u.cacheWrite ?? 0),
			reasoning: Number(u.reasoning ?? 0),
		};
		entry.usage.input += usage.input;
		entry.usage.output += usage.output;
		entry.usage.cacheRead += usage.cacheRead;
		entry.usage.cacheWrite += usage.cacheWrite;
		entry.usage.reasoning += usage.reasoning;
		if (mapped) entry.finalOutput = mapped;
		this.emitChat(s, entry, chat, msg, usage);
	}

	onToolExecutionStart(e: any, ctx: MinimalCtx): void {
		const entry = this.session(ctx).entry;
		if (!entry || !e?.toolCallId) return;
		const parent = (e.parentToolCallId && entry.tools.get(e.parentToolCallId)?.spanId) || entry.step?.spanId || entry.agentSpanId;
		entry.tools.set(e.toolCallId, {
			spanId: newSpanId(),
			parentSpanId: parent,
			stepSeq: entry.step?.seq ?? 0,
			name: String(e.toolName ?? "unknown"),
			callId: e.toolCallId,
			args: e.args,
			startMs: Date.now(),
		});
	}

	onToolExecutionEnd(e: any, ctx: MinimalCtx): void {
		const s = this.session(ctx);
		const entry = s.entry;
		const tool = entry?.tools.get(e?.toolCallId);
		if (!entry || !tool) return;
		entry.tools.delete(tool.callId);
		entry.toolCalls++;
		if (e.isError) entry.toolErrors++;
		const result = mapToolResult(e.result);
		const errMsg = e.isError ? this.toolErrorMessage(result) : undefined;
		this.emitTool(s, entry, tool, Date.now(), result, errMsg, typeof e.durationMs === "number" ? e.durationMs : undefined);
	}

	onTurnEnd(ctx: MinimalCtx): void {
		const s = this.session(ctx);
		if (s.entry?.step) this.closeStep(s, s.entry);
	}

	onAgentEnd(ctx: MinimalCtx): void {
		const s = this.session(ctx);
		const entry = s.entry;
		if (!entry) return;
		this.failDangling(s, entry, "agent run ended before completion");
		if (entry.step) this.closeStep(s, entry);
		s.pendingAgentRequest = false;
	}

	onAgentSettled(e: any, ctx: MinimalCtx): void {
		const s = this.session(ctx);
		if (!s.entry) return;
		let failure: { code: string; message: string } | undefined;
		if (e?.aborted) failure = { code: "ABORTED", message: "Pi run was aborted" };
		else if (s.entry.lastStop === "error") failure = { code: "ERROR", message: s.entry.lastError ?? "LLM request failed" };
		this.closeEntry(s, failure);
	}

	async onSessionShutdown(ctx: MinimalCtx): Promise<void> {
		const s = this.sessions.get(ctx.sessionManager.getSessionId());
		if (s?.entry) this.closeEntry(s, { code: "INTERRUPTED", message: "session shutdown" });
		if (s) this.sessions.delete(s.sid);
		await this.exporter.flush();
	}

	// ───────────────────────────── 内部状态 ─────────────────────────────

	private session(ctx: MinimalCtx): SessionState {
		const sid = ctx.sessionManager.getSessionId();
		let s = this.sessions.get(sid);
		if (!s) {
			s = { sid, cwd: ctx.cwd, promptSeq: 0, pendingAgentRequest: false };
			this.sessions.set(sid, s);
		}
		return s;
	}

	private openEntry(s: SessionState): void {
		s.pendingAgentRequest = false;
		s.entry = {
			seq: ++s.promptSeq,
			traceId: newTraceId(),
			entrySpanId: newSpanId(),
			agentSpanId: newSpanId(),
			startMs: Date.now(),
			inputs: [],
			context: [],
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
			attempts: 0,
			stepSeq: 0,
			tools: new Map(),
			llmCalls: 0,
			toolCalls: 0,
			toolErrors: 0,
		};
	}

	private newChat(s: SessionState, entry: EntryState, ctx: MinimalCtx, startMs = Date.now()): ChatState {
		return {
			spanId: newSpanId(),
			parentSpanId: entry.step?.spanId ?? entry.agentSpanId,
			stepSeq: entry.step?.seq ?? 0,
			startMs,
			startMono: performance.now() - (Date.now() - startMs),
			headersSeen: false,
			requestSeen: false,
			provider: ctx.model?.provider,
			model: ctx.model?.id,
			api: ctx.model?.api,
			// 快照：之后 entry.context 还会追加本次响应，不能持有活引用
			inputs: this.config.captureContent ? entry.context.slice() : [],
		};
	}

	private ensureChat(s: SessionState, entry: EntryState, ctx: MinimalCtx): ChatState {
		if (!entry.chat) entry.chat = this.newChat(s, entry, ctx);
		return entry.chat;
	}

	private failDangling(s: SessionState, entry: EntryState, reason: string): void {
		const now = Date.now();
		if (entry.chat) {
			const chat = entry.chat;
			entry.chat = undefined;
			this.emitChat(s, entry, chat, { stopReason: "error", errorMessage: reason }, undefined, now);
		}
		for (const tool of entry.tools.values()) this.emitTool(s, entry, tool, now, undefined, reason);
		entry.tools.clear();
	}

	private closeStep(s: SessionState, entry: EntryState): void {
		const step = entry.step;
		if (!step) return;
		entry.step = undefined;
		const finish = mapFinishReason(step.lastStop);
		const isFail = step.lastStop === "error" || step.lastStop === "aborted";
		this.exporter.export(
			buildSpan({
				spanKind: "step",
				traceID: entry.traceId,
				spanID: step.spanId,
				parentSpanID: entry.agentSpanId,
				sessionID: s.sid,
				stepID: this.stepId(s, entry, step.seq),
				name: `react round_${step.seq}`,
				kind: "INTERNAL",
				error: isFail ? finish : undefined,
				startMs: step.startMs,
				endMs: Date.now(),
				host: this.host,
				service: this.config.serviceName,
				attribute: {
					"gen_ai.span.kind": "step",
					"gen_ai.operation.name": "react",
					"gen_ai.session.id": s.sid,
					"gen_ai.turn.id": this.turnId(s, entry),
					"gen_ai.step.id": this.stepId(s, entry, step.seq),
					"gen_ai.react.round": step.seq,
					"gen_ai.react.finish_reason": finish,
					"pi.turn_index": step.turnIndex,
					"pi.agent.attempt": step.attempt,
					...this.sdkAttrs(),
				},
			}),
		);
	}

	private closeEntry(s: SessionState, failure?: { code: string; message: string }): void {
		const entry = s.entry;
		if (!entry) return;
		this.failDangling(s, entry, failure?.message ?? "entry closed");
		if (entry.step) this.closeStep(s, entry);
		s.entry = undefined;
		s.pendingAgentRequest = false;
		const endMs = Date.now();
		const finish = failure ? failure.code.toLowerCase() : mapFinishReason(entry.lastStop);
		const totalIn = entry.usage.input + entry.usage.cacheRead + entry.usage.cacheWrite;
		const common = this.commonAttrs(s, entry);
		const content: Record<string, AttrValue | undefined> = {};
		if (this.config.captureContent) {
			content["gen_ai.input.messages"] = this.clip(entry.inputs);
			content["gen_ai.output.messages"] = this.clip(entry.finalOutput ? [entry.finalOutput] : []);
		}
		this.exporter.export(
			buildSpan({
				spanKind: "agent",
				traceID: entry.traceId,
				spanID: entry.agentSpanId,
				parentSpanID: entry.entrySpanId,
				sessionID: s.sid,
				agentID: entry.agentSpanId,
				name: "invoke_agent pi",
				kind: "INTERNAL",
				error: failure?.message,
				startMs: entry.startMs,
				endMs,
				host: this.host,
				service: this.config.serviceName,
				attribute: {
					...common,
					"gen_ai.span.kind": "agent",
					"gen_ai.operation.name": "invoke_agent",
					"gen_ai.agent.type": "pi-coding-agent",
					"gen_ai.response.finish_reasons": safeStringify([finish]),
					"gen_ai.request.model": entry.model,
					"gen_ai.system": entry.provider,
					"gen_ai.usage.input_tokens": totalIn,
					"gen_ai.usage.output_tokens": entry.usage.output,
					"gen_ai.usage.total_tokens": totalIn + entry.usage.output,
					"gen_ai.usage.cache_read.input_tokens": entry.usage.cacheRead || undefined,
					"gen_ai.usage.cache_creation.input_tokens": entry.usage.cacheWrite || undefined,
					"gen_ai.usage.reasoning_tokens": entry.usage.reasoning || undefined,
					"pi.agent.attempts": entry.attempts,
					"pi.agent.retries": Math.max(0, entry.attempts - 1),
					"pi.llm.calls": entry.llmCalls,
					"pi.tool.calls": entry.toolCalls,
					"pi.tool.errors": entry.toolErrors,
					"error.type": failure?.code,
					...content,
				},
			}),
		);
		this.exporter.export(
			buildSpan({
				spanKind: "entry",
				traceID: entry.traceId,
				spanID: entry.entrySpanId,
				sessionID: s.sid,
				name: "enter_application",
				kind: "SERVER",
				error: failure?.message,
				startMs: entry.startMs,
				endMs,
				host: this.host,
				service: this.config.serviceName,
				attribute: {
					...common,
					"gen_ai.span.kind": "entry",
					"gen_ai.operation.name": "enter_application",
					"gen_ai.entry.type": "pi",
					"pi.run.end_reason": finish,
					"error.type": failure?.code,
					...content,
				},
			}),
		);
	}

	private emitChat(s: SessionState, entry: EntryState, chat: ChatState, msg: any, usage?: Usage, endMs = Date.now()): void {
		const stop: string | undefined = msg.stopReason;
		const finish = mapFinishReason(stop);
		const isError = stop === "error" || stop === "aborted";
		const errMsg: string | undefined = isError ? (msg.errorMessage ?? finish) : undefined;
		const status = errMsg ? /^(\d{3})\b/.exec(errMsg)?.[1] : undefined;
		const totalIn = usage ? usage.input + usage.cacheRead + usage.cacheWrite : undefined;
		const model = chat.model ?? msg.model;
		const provider = chat.provider ?? msg.provider;
		const attrs: Record<string, AttrValue | undefined> = {
			"gen_ai.span.kind": "chat",
			"gen_ai.operation.name": "chat",
			"gen_ai.session.id": s.sid,
			"gen_ai.conversation.id": s.sid,
			"gen_ai.turn.id": this.turnId(s, entry),
			"gen_ai.step.id": chat.stepSeq ? this.stepId(s, entry, chat.stepSeq) : undefined,
			"gen_ai.system": provider,
			"gen_ai.provider.name": provider,
			"gen_ai.request.model": model,
			"gen_ai.response.model": msg.responseModel ?? msg.model ?? model,
			"gen_ai.response.id": msg.responseId,
			"gen_ai.response.finish_reasons": safeStringify([finish]),
			"gen_ai.request.max_tokens": chat.maxTokens,
			"gen_ai.request.temperature": chat.temperature,
			"gen_ai.usage.input_tokens": totalIn,
			"gen_ai.usage.output_tokens": usage?.output,
			"gen_ai.usage.total_tokens": usage && totalIn !== undefined ? totalIn + usage.output : undefined,
			"gen_ai.usage.cache_read.input_tokens": usage?.cacheRead || undefined,
			"gen_ai.usage.cache_creation.input_tokens": usage?.cacheWrite || undefined,
			"gen_ai.usage.reasoning_tokens": usage?.reasoning || undefined,
			"gen_ai.response.time_to_first_token_ms":
				chat.firstMono !== undefined ? Math.max(0, Math.round(chat.firstMono - (chat.requestMono ?? chat.startMono))) : undefined,
			"http.response.status_code": chat.httpStatus ?? (status ? Number(status) : undefined),
			"pi.api": chat.api ?? msg.api,
			"pi.provider.request_id": chat.requestId,
			"pi.request.prepare_ms": chat.requestMs !== undefined ? chat.requestMs - chat.startMs : undefined,
			"pi.request.hooks": chat.requestSeen ? "provider" : "synthetic",
			"pi.trace.foreign_traceparent": chat.foreignTraceparent || undefined,
			"pi.agent.attempt": entry.attempts,
			"error.type": isError ? (stop === "aborted" ? "aborted" : (status ?? "error")) : undefined,
			...this.sdkAttrs(),
		};
		if (this.config.captureContent) {
			attrs["gen_ai.input.messages"] = this.clip(chat.inputs);
			const out = mapAgentMessage(msg.role ? msg : undefined);
			if (out) attrs["gen_ai.output.messages"] = this.clip([out]);
			if (s.systemPrompt) attrs["gen_ai.system_instructions"] = this.clip([{ type: "text", content: s.systemPrompt }]);
			const defs = this.safeToolDefs();
			if (defs) attrs["gen_ai.tool.definitions"] = this.clip(defs);
		}
		this.exporter.export(
			buildSpan({
				spanKind: "chat",
				traceID: entry.traceId,
				spanID: chat.spanId,
				parentSpanID: chat.parentSpanId,
				sessionID: s.sid,
				stepID: chat.stepSeq ? this.stepId(s, entry, chat.stepSeq) : "",
				name: `chat ${model ?? "unknown"}`,
				kind: "CLIENT",
				error: errMsg,
				startMs: chat.startMs,
				endMs,
				host: this.host,
				service: this.config.serviceName,
				attribute: attrs,
			}),
		);
	}

	private emitTool(s: SessionState, entry: EntryState, tool: ToolState, endMs: number, result: unknown, errMsg?: string, execMs?: number): void {
		const attrs: Record<string, AttrValue | undefined> = {
			"gen_ai.span.kind": "tool",
			"gen_ai.operation.name": "execute_tool",
			"gen_ai.session.id": s.sid,
			"gen_ai.turn.id": this.turnId(s, entry),
			"gen_ai.step.id": tool.stepSeq ? this.stepId(s, entry, tool.stepSeq) : undefined,
			"gen_ai.tool.name": tool.name,
			"gen_ai.tool.type": "function",
			"gen_ai.tool.call.id": tool.callId,
			"gen_ai.tool.call.duration_ms": Math.max(0, endMs - tool.startMs),
			"pi.tool.execute_ms": execMs,
			"error.type": errMsg ? "ToolError" : undefined,
			...this.sdkAttrs(),
		};
		if (this.config.captureContent) {
			attrs["gen_ai.tool.call.arguments"] = this.clip(tool.args);
			if (result !== undefined) attrs["gen_ai.tool.call.result"] = this.clip(result);
		}
		this.exporter.export(
			buildSpan({
				spanKind: "tool",
				traceID: entry.traceId,
				spanID: tool.spanId,
				parentSpanID: tool.parentSpanId,
				sessionID: s.sid,
				stepID: tool.stepSeq ? this.stepId(s, entry, tool.stepSeq) : "",
				name: `execute_tool ${tool.name}`,
				kind: "CLIENT",
				error: errMsg,
				startMs: tool.startMs,
				endMs,
				host: this.host,
				service: this.config.serviceName,
				attribute: attrs,
			}),
		);
	}

	private toolErrorMessage(result: unknown): string {
		if (Array.isArray(result)) {
			const text = result.find((p: any) => p?.type === "text")?.content;
			if (typeof text === "string" && text) return text.slice(0, 256);
		}
		return "Tool execution failed";
	}

	private safeToolDefs(): unknown[] | undefined {
		try {
			return this.hooks.getToolDefinitions?.();
		} catch {
			return undefined;
		}
	}

	private clip(value: unknown): string {
		return truncate(safeStringify(value), this.config.contentMaxChars);
	}

	private turnId(s: SessionState, entry: EntryState): string {
		return `${s.sid}:t${entry.seq}`;
	}

	private stepId(s: SessionState, entry: EntryState, step: number): string {
		return `${s.sid}:t${entry.seq}:s${step}`;
	}

	private sdkAttrs(): Record<string, AttrValue> {
		return { "telemetry.sdk.name": "tencentcloud-agentobs-sdk-pi", "telemetry.sdk.language": "javascript", "telemetry.sdk.version": VERSION };
	}

	private commonAttrs(s: SessionState, entry: EntryState): Record<string, AttrValue | undefined> {
		return {
			"gen_ai.agent.system": "pi",
			"gen_ai.agent.name": "pi",
			"gen_ai.session.id": s.sid,
			"gen_ai.conversation.id": s.sid,
			"gen_ai.turn.id": this.turnId(s, entry),
			"pi.session.id": s.sid,
			"pi.turn": entry.seq,
			"pi.session.cwd": s.cwd,
			"service.name": this.config.serviceName,
			"service.instance.id": this.instanceId,
			...this.sdkAttrs(),
			...this.config.resourceAttributes,
		};
	}
}
