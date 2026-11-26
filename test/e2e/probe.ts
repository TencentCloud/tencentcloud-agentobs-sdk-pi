// 事件探针：不做埋点，只记录 v1.3.0 真实的扩展事件时序，用来回答“重试时事件怎么触发”。
// 用法：node --experimental-strip-types test/e2e/probe.ts [场景字母，如 B]
import { createHarness } from "./harness.ts";

const EVENTS = [
	"session_start", "before_agent_start", "agent_start", "turn_start", "context",
	"before_provider_request", "before_provider_headers", "after_provider_response",
	"message_start", "message_update", "message_end", "tool_call", "tool_execution_start",
	"tool_execution_end", "tool_result", "turn_end", "agent_end", "agent_before_settle",
	"agent_settled", "session_shutdown", "cache_warming_decision",
];
const ONLY = process.argv[2];

const log: string[] = [];
let lastUpdate = false;
const t0 = { v: 0 };
const probe = (pi: any) => {
	for (const name of EVENTS) {
		pi.on(name, (e: any, ctx: any) => {
			if (name === "message_update") {
				if (lastUpdate) return;
				lastUpdate = true;
			} else lastUpdate = false;
			let extra = "";
			if (name.startsWith("message_")) extra = `role=${e.message?.role}`;
			if (name === "message_end" && e.message?.role === "assistant") {
				const m = e.message;
				extra += ` stop=${m.stopReason} model=${m.model} respModel=${m.responseModel} respId=${m.responseId} usage(in/out/cacheRead/cacheWrite)=${m.usage?.input}/${m.usage?.output}/${m.usage?.cacheRead}/${m.usage?.cacheWrite} err=${m.errorMessage ?? ""}`;
			}
			if (name === "after_provider_response") extra = `status=${e.status} xrid=${e.headers?.["x-request-id"]}`;
			if (name === "before_provider_request")
				extra = `ctx.model=${ctx.model?.provider}/${ctx.model?.id} api=${ctx.model?.api} payload.model=${(e.payload as any)?.model} max_tokens=${(e.payload as any)?.max_completion_tokens ?? (e.payload as any)?.max_tokens}`;
			if (name.startsWith("tool_execution")) extra = `id=${e.toolCallId} ${e.toolName} err=${e.isError ?? ""} dur=${e.durationMs ?? ""}`;
			if (name === "turn_start" || name === "turn_end") extra = `turn=${e.turnIndex}`;
			if (name === "agent_settled") extra = `aborted=${e.aborted}`;
			if (name === "cache_warming_decision") extra = `action=${e.action}`;
			if (name === "agent_start" || name === "session_start") extra += ` sid=${ctx.sessionManager.getSessionId()}`;
			const ms = String(Date.now() - t0.v).padStart(5);
			log.push(`${ms}ms ${name}${name === "message_update" ? "(…)" : ""} ${extra}`.trimEnd());
			// W 场景：mock 用量太小经济性判定为 stop，这里用扩展覆盖强制预热一次，观察预热请求会触发哪些事件
			if (name === "cache_warming_decision" && ONLY === "W") return { action: "warm" };
		});
	}
};

async function scenario(
	key: string,
	title: string,
	setup: (llm: any) => void,
	prompt: string,
	extra: { settings?: any; modelExtra?: any; waitMs?: number; abortAfterMs?: number } = {},
) {
	if (ONLY && ONLY !== key) return;
	const h = await createHarness({ factories: [probe], settings: extra.settings, modelExtra: extra.modelExtra });
	log.length = 0;
	t0.v = Date.now();
	setup(h.llm);
	if (extra.abortAfterMs) setTimeout(() => void h.session.abort(), extra.abortAfterMs);
	await h.session.prompt(prompt);
	await h.session.waitForIdle?.();
	if (extra.waitMs) {
		console.log(`[${key}] model.promptCache=${JSON.stringify((h.model as any).promptCache)} cacheWarmingStatus=${JSON.stringify(h.session.cacheWarmingStatus)}`);
		await new Promise((r) => setTimeout(r, extra.waitMs));
	}
	const maxTok = h.llm.requests.map((r: any) => r.body?.max_completion_tokens ?? r.body?.max_tokens);
	console.log(`\n===== ${key} ${title}  (HTTP 请求数=${h.llm.requests.length}, max_tokens=${JSON.stringify(maxTok)}) =====`);
	for (const l of log) console.log("  " + l);
	await h.close();
}

const twoReads = { kind: "tools", calls: [{ id: "call_a", name: "read", args: { path: "a.txt" } }, { id: "call_b", name: "read", args: { path: "b.txt" } }] };
const err503 = { kind: "http_error", status: 503 };

await scenario("A", "正常：并行两个 read 工具 + 最终文本", (llm) => llm.script(twoReads, { kind: "text", text: "both files say hello" }), "read a.txt and b.txt");
await scenario("B", "agent 级重试：第一次 503，自动重试后成功", (llm) => llm.script(err503, { kind: "text", text: "ok after retry" }), "hi");
await scenario("C", "agent 级重试耗尽：连续 503（maxRetries=2）", (llm) => llm.script(err503, err503, err503), "hi");
await scenario("D", "不可重试错误：400", (llm) => llm.script({ kind: "http_error", status: 400, body: JSON.stringify({ error: { message: "bad request" } }) }), "hi");
await scenario(
	"E",
	"provider 级重试：retry.provider.maxRetries=2，agent 级关闭",
	(llm) => llm.script(err503, { kind: "text", text: "ok after provider retry" }),
	"hi",
	{ settings: { retry: { enabled: false, provider: { maxRetries: 2, maxRetryDelayMs: 200 } } } },
);
await scenario(
	"F",
	"工具报错：read 不存在的文件",
	(llm) => llm.script({ kind: "tools", calls: [{ id: "call_x", name: "read", args: { path: "missing.txt" } }] }, { kind: "text", text: "file missing" }),
	"read missing.txt",
);
await scenario("G", "中途 abort", (llm) => llm.script({ kind: "text", text: "a ".repeat(400) }), "long", { abortAfterMs: 80 });
await scenario(
	"W",
	"cache warming（idle 模式，promptCache.short=30s → 20s 后预热）",
	(llm) => llm.script({ kind: "text", text: "hello", usage: [20000, 10] }, { kind: "text", text: "warm", usage: [20000, 1] }),
	"hi",
	{
		settings: { cacheWarming: "idle" },
		modelExtra: { promptCache: { short: 30 }, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
		waitMs: 16000,
	},
);
