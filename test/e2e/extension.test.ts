// 端到端断言：真实 pi-coding-agent@1.3.0 + MockLLM + 本扩展（dist 产物），用 MemoryExporter 收集 span。
// 运行：npm test（会先 build）。W 场景需等待 cache warming（约 20s），设 AGENTOBS_E2E_SKIP_SLOW=1 可跳过。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { type CLSSpan, createAgentObsExtension, MemoryExporter } from "../../dist/index.js";
import { createHarness, type HarnessOptions } from "./harness.ts";
import type { Step } from "./mock-server.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
const EXT_PATH = path.join(ROOT, "dist", "extension.js");
const twoReads: Step = { kind: "tools", calls: [{ id: "call_a", name: "read", args: { path: "a.txt" } }, { id: "call_b", name: "read", args: { path: "b.txt" } }] };
const err503: Step = { kind: "http_error", status: 503 };
const silent = { info() {}, warn() {} };

interface RunOpts extends HarnessOptions {
	script: Step[];
	prompt?: string;
	abortAfterMs?: number;
	/** prompt 结束后继续等待，直到条件满足（用于 cache warming） */
	waitUntil?: (h: Awaited<ReturnType<typeof createHarness>>) => boolean;
	waitTimeoutMs?: number;
}

async function run(opts: RunOpts) {
	const h = await createHarness(opts);
	h.llm.script(...opts.script);
	if (opts.abortAfterMs) setTimeout(() => void h.session.abort(), opts.abortAfterMs);
	await h.session.prompt(opts.prompt ?? "hi");
	if (opts.waitUntil) {
		const deadline = Date.now() + (opts.waitTimeoutMs ?? 30_000);
		while (!opts.waitUntil(h) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
		await new Promise((r) => setTimeout(r, 300)); // 让预热请求的 after_provider_response 跑完
	}
	await h.close();
	return h;
}

/** 单个扩展实例 + 独立 MemoryExporter */
function obs(extra: Parameters<typeof createAgentObsExtension>[0] = {}) {
	const mem = new MemoryExporter();
	return { mem, factory: createAgentObsExtension({ spanExporter: mem, logger: silent, ...extra }) };
}

const kind = (spans: CLSSpan[], k: string) => spans.filter((s) => s.spanKind === k);
const one = (spans: CLSSpan[], k: string) => {
	const list = kind(spans, k);
	assert.equal(list.length, 1, `expected exactly 1 ${k} span, got ${list.length}`);
	return list[0]!;
};
const attr = (s: CLSSpan, k: string) => (s.attribute as Record<string, unknown>)[k];

/** 通用结构不变量：单 trace、唯一 entry 为根、父节点都存在、层级合法、无重复 spanID */
function assertWellFormed(spans: CLSSpan[]) {
	assert.ok(spans.length > 0, "no spans exported");
	assert.equal(new Set(spans.map((s) => s.traceID)).size, 1, "spans should share one trace");
	assert.equal(new Set(spans.map((s) => s.spanID)).size, spans.length, "duplicate spanID");
	const byId = new Map(spans.map((s) => [s.spanID, s]));
	const entry = one(spans, "entry");
	assert.equal(entry.parentSpanID, "");
	const allowedParent: Record<string, string[]> = { agent: ["entry"], step: ["agent"], chat: ["step", "agent"], tool: ["step", "agent", "tool"] };
	for (const s of spans) {
		if (s === entry) continue;
		const p = byId.get(s.parentSpanID);
		assert.ok(p, `${s.name} has orphan parent ${s.parentSpanID}`);
		assert.ok(allowedParent[s.spanKind]?.includes(p.spanKind), `${s.spanKind} under ${p.spanKind}`);
		assert.ok(BigInt(s.start) >= BigInt(p.start), `${s.name} starts before parent`);
	}
}

describe("tencentcloud-agentobs-sdk-pi @ pi-coding-agent 1.3.0", () => {
	test("A 正常：entry → agent → step×2 → chat / 并行 tool×2，usage 与响应字段", async () => {
		const { mem, factory } = obs();
		await run({ factories: [factory], script: [twoReads, { kind: "text", text: "both files say hello" }], prompt: "read a.txt and b.txt" });
		const spans = mem.spans;
		assertWellFormed(spans);
		assert.equal(spans.length, 8);
		const steps = kind(spans, "step").sort((a, b) => Number(attr(a, "gen_ai.react.round")) - Number(attr(b, "gen_ai.react.round")));
		assert.equal(steps.length, 2);
		const tools = kind(spans, "tool");
		assert.equal(tools.length, 2);
		for (const t of tools) assert.equal(t.parentSpanID, steps[0]!.spanID, "tools belong to round_1");
		assert.deepEqual(tools.map((t) => attr(t, "gen_ai.tool.call.id")).sort(), ["call_a", "call_b"]);

		const chats = kind(spans, "chat");
		assert.equal(chats.length, 2);
		for (const c of chats) {
			assert.equal(c.statusCode, "OK");
			assert.equal(attr(c, "gen_ai.system"), "mock"); // ctx.model.provider
			assert.equal(attr(c, "gen_ai.request.model"), "mock-gpt"); // ctx.model.id
			assert.equal(attr(c, "pi.api"), "openai-completions"); // ctx.model.api
			assert.equal(attr(c, "gen_ai.response.model"), "mock-gpt-2026-11-01"); // assistant.responseModel
			assert.match(String(attr(c, "gen_ai.response.id")), /^chatcmpl-\d+$/);
			assert.match(String(attr(c, "pi.provider.request_id")), /^req-\d+$/);
			assert.equal(attr(c, "http.response.status_code"), 200);
			// mock: prompt=100 其中 cached=40 → pi usage.input=60, cacheRead=40；上报 input_tokens 应还原为 100
			assert.equal(attr(c, "gen_ai.usage.input_tokens"), 100);
			assert.equal(attr(c, "gen_ai.usage.cache_read.input_tokens"), 40);
			assert.equal(attr(c, "gen_ai.usage.output_tokens"), 20);
			assert.equal(attr(c, "pi.request.hooks"), "provider");
			// TTFT 从 before_provider_request 起算，不含 provider SDK 冷加载（prepare_ms）；mock 首包 ≈ 5ms 级
			const ttft = Number(attr(c, "gen_ai.response.time_to_first_token_ms"));
			assert.ok(ttft >= 0 && ttft < 1000, `ttft=${ttft} prepare_ms=${attr(c, "pi.request.prepare_ms")}`);
		}
		const agent = one(spans, "agent");
		assert.equal(attr(agent, "gen_ai.usage.input_tokens"), 200);
		assert.equal(attr(agent, "pi.agent.attempts"), 1);
		assert.equal(attr(agent, "pi.llm.calls"), 2);
		assert.equal(attr(agent, "pi.tool.calls"), 2);
		assert.equal(one(spans, "entry").statusCode, "OK");
	});

	test("B agent 级重试 503→200：仍是 1 个 entry，attempt 1/2 各一个 step+chat，turn_index 均为 0", async () => {
		const { mem, factory } = obs();
		const h = await run({ factories: [factory], script: [err503, { kind: "text", text: "ok after retry" }] });
		const spans = mem.spans;
		assertWellFormed(spans);
		assert.equal(h.llm.requests.length, 2);
		const agent = one(spans, "agent");
		assert.equal(attr(agent, "pi.agent.attempts"), 2);
		assert.equal(attr(agent, "pi.agent.retries"), 1);
		const steps = kind(spans, "step");
		assert.deepEqual(steps.map((s) => attr(s, "pi.agent.attempt")).sort(), [1, 2]);
		assert.deepEqual(steps.map((s) => attr(s, "pi.turn_index")), [0, 0]);
		const chats = kind(spans, "chat").sort((a, b) => Number(attr(a, "pi.agent.attempt")) - Number(attr(b, "pi.agent.attempt")));
		assert.equal(chats.length, 2);
		assert.equal(chats[0]!.statusCode, "ERROR");
		assert.equal(attr(chats[0]!, "http.response.status_code"), 503); // 从 errorMessage 解析（失败请求没有 after_provider_response）
		assert.equal(attr(chats[0]!, "pi.provider.request_id"), undefined);
		assert.equal(attr(chats[0]!, "error.type"), "503");
		assert.equal(chats[1]!.statusCode, "OK");
		assert.equal(one(spans, "entry").statusCode, "OK");
	});

	test("C agent 级重试耗尽（maxRetries=2）：3 次尝试，entry/agent 为 ERROR", async () => {
		const { mem, factory } = obs();
		const h = await run({ factories: [factory], script: [err503, err503, err503] });
		const spans = mem.spans;
		assertWellFormed(spans);
		assert.equal(h.llm.requests.length, 3);
		assert.equal(kind(spans, "chat").length, 3);
		assert.ok(kind(spans, "chat").every((c) => c.statusCode === "ERROR"));
		assert.equal(attr(one(spans, "agent"), "pi.agent.attempts"), 3);
		assert.equal(one(spans, "entry").statusCode, "ERROR");
		assert.equal(attr(one(spans, "entry"), "error.type"), "ERROR");
	});

	test("D 不可重试 400：单次尝试即失败", async () => {
		const { mem, factory } = obs();
		const h = await run({ factories: [factory], script: [{ kind: "http_error", status: 400, body: JSON.stringify({ error: { message: "bad request" } }) }] });
		const spans = mem.spans;
		assertWellFormed(spans);
		assert.equal(h.llm.requests.length, 1);
		const chat = one(spans, "chat");
		assert.equal(attr(chat, "http.response.status_code"), 400);
		assert.equal(attr(one(spans, "agent"), "pi.agent.attempts"), 1);
		assert.equal(one(spans, "entry").statusCode, "ERROR");
	});

	test("E provider 级重试对扩展不可见：2 次 HTTP 只产生 1 个 chat span", async () => {
		const { mem, factory } = obs();
		const h = await run({
			factories: [factory],
			script: [err503, { kind: "text", text: "ok after provider retry" }],
			settings: { retry: { enabled: false, provider: { maxRetries: 2, maxRetryDelayMs: 200 } } },
		});
		const spans = mem.spans;
		assertWellFormed(spans);
		assert.equal(h.llm.requests.length, 2);
		const chat = one(spans, "chat");
		assert.equal(chat.statusCode, "OK");
		assert.equal(attr(chat, "http.response.status_code"), 200);
		assert.equal(attr(one(spans, "agent"), "pi.agent.attempts"), 1);
	});

	test("F 工具报错：tool span 为 ERROR，整体 entry 仍成功", async () => {
		const { mem, factory } = obs();
		await run({
			factories: [factory],
			script: [{ kind: "tools", calls: [{ id: "call_x", name: "read", args: { path: "missing.txt" } }] }, { kind: "text", text: "file missing" }],
			prompt: "read missing.txt",
		});
		const spans = mem.spans;
		assertWellFormed(spans);
		const tool = one(spans, "tool");
		assert.equal(tool.statusCode, "ERROR");
		assert.equal(attr(tool, "error.type"), "ToolError");
		assert.match(tool.statusMessage, /ENOENT|not found|no such file/i);
		assert.equal(attr(one(spans, "agent"), "pi.tool.errors"), 1);
		assert.equal(one(spans, "entry").statusCode, "OK");
	});

	test("G 中途 abort：chat 为 aborted，entry 记 ABORTED，无悬挂 span", async () => {
		const { mem, factory } = obs();
		await run({ factories: [factory], script: [{ kind: "text", text: "a ".repeat(400) }], prompt: "long", abortAfterMs: 300 });
		const spans = mem.spans;
		assertWellFormed(spans);
		const chat = one(spans, "chat");
		assert.equal(chat.statusCode, "ERROR");
		assert.equal(attr(chat, "error.type"), "aborted");
		const entry = one(spans, "entry");
		assert.equal(entry.statusCode, "ERROR");
		assert.equal(attr(entry, "error.type"), "ABORTED");
	});

	test(
		"W cache warming 预热请求不产生 chat span / 孤儿 span",
		{ skip: process.env.AGENTOBS_E2E_SKIP_SLOW === "1" ? "AGENTOBS_E2E_SKIP_SLOW=1" : false, timeout: 60_000 },
		async () => {
			const { mem, factory } = obs();
			// 另一个扩展强制把经济性决策改成 warm（mock 用量太小，默认会判 stop）
			const forceWarm = (pi: any) => pi.on("cache_warming_decision", () => ({ action: "warm" }));
			const h = await run({
				factories: [factory, forceWarm],
				script: [{ kind: "text", text: "hello", usage: [20000, 10] }, { kind: "text", text: "warm", usage: [20000, 1] }],
				settings: { cacheWarming: "idle" },
				modelExtra: { promptCache: { short: 30 }, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
				waitUntil: (hh) => hh.llm.requests.length >= 2,
				waitTimeoutMs: 40_000,
			});
			assert.equal(h.llm.requests.length, 2, "warming request should have been sent");
			const warmBody = h.llm.requests[1]!.body;
			assert.equal(warmBody?.max_completion_tokens ?? warmBody?.max_tokens, 1, "2nd request is the max_tokens=1 warm-up");
			const spans = mem.spans;
			assertWellFormed(spans);
			assert.equal(kind(spans, "chat").length, 1, "only the real agent request becomes a chat span");
		},
	);

	test("去重：同一会话加载两个扩展实例，只有先到者上报", async () => {
		const a = obs();
		const b = obs();
		await run({ factories: [a.factory, b.factory], script: [{ kind: "text", text: "hi" }] });
		const counts = [a.mem.spans.length, b.mem.spans.length];
		assert.ok(counts.includes(0), `one instance must stay silent, got ${counts}`);
		const spans = a.mem.spans.length ? a.mem.spans : b.mem.spans;
		assertWellFormed(spans);
		assert.equal(spans.length, 4); // entry/agent/step/chat
	});

	test("去重：文件扩展（jiti 加载 dist/extension.js）+ SDK factory 跨模块实例也只上报一份", async () => {
		const file = path.join(ROOT, ".tmp", `dedup-${Date.now()}.jsonl`);
		process.env.AGENTOBS_EXPORTER = "console";
		process.env.AGENTOBS_CONSOLE_FILE = file;
		try {
			const { mem, factory } = obs();
			await run({ extensionPaths: [EXT_PATH], factories: [factory], script: [{ kind: "text", text: "hi" }] });
			const fileSpans: CLSSpan[] = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
			const counts = [fileSpans.length, mem.spans.length];
			assert.ok(counts.includes(0) && counts.includes(4), `expected exactly one reporter with 4 spans, got file=${counts[0]} mem=${counts[1]}`);
		} finally {
			delete process.env.AGENTOBS_EXPORTER;
			delete process.env.AGENTOBS_CONSOLE_FILE;
		}
	});

	test("内容采集：默认开启；captureContent=false 时所有 span 都不含消息/参数/结果", async () => {
		const on = obs();
		await run({ factories: [on.factory], script: [twoReads, { kind: "text", text: "secret answer" }], prompt: "read a.txt and b.txt" });
		const chatOn = kind(on.mem.spans, "chat")[0]!;
		assert.match(String(attr(chatOn, "gen_ai.input.messages")), /read a\.txt and b\.txt/);
		assert.ok(attr(chatOn, "gen_ai.system_instructions"));
		assert.match(String(attr(chatOn, "gen_ai.tool.definitions")), /"name":"read"/);
		assert.match(String(attr(kind(on.mem.spans, "tool")[0]!, "gen_ai.tool.call.result")), /hello from/);

		const off = obs({ captureContent: false });
		await run({ factories: [off.factory], script: [twoReads, { kind: "text", text: "secret answer" }], prompt: "read a.txt and b.txt" });
		const CONTENT_KEYS = ["gen_ai.input.messages", "gen_ai.output.messages", "gen_ai.system_instructions", "gen_ai.tool.definitions", "gen_ai.tool.call.arguments", "gen_ai.tool.call.result"];
		for (const s of off.mem.spans) for (const k of CONTENT_KEYS) assert.equal(attr(s, k), undefined, `${s.spanKind}.${k} leaked`);
		assert.ok(!JSON.stringify(off.mem.spans).includes("secret answer"));
		assert.ok(!JSON.stringify(off.mem.spans).includes("hello from"));
	});

	test("traceparent：默认不注入；开启后每个 agent 请求带上对应 chat span 的 traceparent", async () => {
		const def = obs();
		const h0 = await run({ factories: [def.factory], script: [{ kind: "text", text: "x" }] });
		assert.equal(h0.llm.requests[0]!.headers.traceparent, undefined);

		const tp = obs({ propagateTraceparent: true });
		const h = await run({ factories: [tp.factory], script: [err503, twoReads, { kind: "text", text: "done" }], prompt: "read a.txt and b.txt" });
		const expected = new Set(kind(tp.mem.spans, "chat").map((c) => `00-${c.traceID}-${c.spanID}-01`));
		const got = h.llm.requests.map((r) => r.headers.traceparent);
		assert.equal(got.length, 3);
		for (const t of got) assert.ok(expected.has(String(t)), `traceparent ${t} does not match any chat span`);
		assert.equal(new Set(got).size, 3, "each attempt/request gets its own chat span id");
	});
});
