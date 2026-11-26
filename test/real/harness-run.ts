// SDK 内嵌模式的真实环境验证（README「以 SDK 方式嵌入自己的 Pi 应用」那条路径）：
//   本进程内 createAgentSession + DefaultResourceLoader({ extensionFactories: [createAgentObsExtension(...)] })
//   → 真实 CLS 上报 → 云 API SearchLog 回查。
// 与 test/real/run.ts 的区别：那边是真实 pi CLI 子进程 + pi install 包发现，这边是 SDK 工厂注入、同进程。
// LLM：配置 REAL_LLM_BASE_URL 时走真实模型，否则用本进程内的 OpenAI 兼容 mock。
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ClsExporter, createAgentObsExtension, type CLSSpan, resolveConfig } from "../../dist/index.js";
import { createHarness, createRealHarness } from "../e2e/harness.ts";
import type { MockLLM } from "../e2e/mock-server.ts";
import { renderTrees } from "../e2e/tree.ts";
import { ClsApi, ClsApiError, regionFromEndpoint } from "./cls-api.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");

function fail(msg: string): never {
	console.error(`✖ ${msg}`);
	process.exit(2);
}
function requireEnv(name: string): string {
	const v = process.env[name]?.trim();
	if (!v) fail(`missing env ${name}`);
	return v;
}
function validateLlmUrl(raw: string): string {
	const u = new URL(raw.trim());
	const local = u.hostname === "127.0.0.1" || u.hostname === "localhost";
	if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) fail("REAL_LLM_BASE_URL must be https:// (http only for localhost)");
	return u.toString().replace(/\/+$/, "");
}
const mask = (s: string) => (s.length <= 8 ? "***" : `${s.slice(0, 4)}…${s.slice(-4)}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CLS = {
	endpoint: requireEnv("CLS_ENDPOINT"),
	topicId: requireEnv("CLS_TOPIC_ID"),
	secretId: requireEnv("CLS_SECRET_ID"),
	secretKey: requireEnv("CLS_SECRET_KEY"),
};
const region = process.env.CLS_REGION?.trim() || regionFromEndpoint(CLS.endpoint);
if (!region) fail(`cannot infer region from CLS_ENDPOINT=${CLS.endpoint}, set CLS_REGION`);
const api = new ClsApi({ secretId: CLS.secretId, secretKey: CLS.secretKey, token: process.env.CLS_TOKEN, region, host: process.env.CLS_API_HOST });

const REAL_LLM = process.env.REAL_LLM_BASE_URL
	? { baseUrl: validateLlmUrl(process.env.REAL_LLM_BASE_URL), model: requireEnv("REAL_LLM_MODEL"), api: process.env.REAL_LLM_API?.trim() || "openai-completions" }
	: undefined;
if (REAL_LLM) requireEnv("REAL_LLM_API_KEY");

const runId = randomBytes(8).toString("hex");
const serviceName = "pi-harness";
const WAIT_MS = Number(process.env.AGENTOBS_WAIT_SEC ?? "120") * 1000;

console.log(`━━━━ SDK 内嵌模式验证  run=${runId}`);
console.log(`  接入方式    : DefaultResourceLoader({ extensionFactories: [createAgentObsExtension(...)] })（同进程，无子进程）`);
console.log(`  CLS         : ${CLS.endpoint}  topic=${mask(CLS.topicId)}  region=${region}  service=${serviceName}`);
console.log(`  LLM         : ${REAL_LLM ? `real ${REAL_LLM.api} ${new URL(REAL_LLM.baseUrl).host} model=${REAL_LLM.model}` : "mock (本进程内 OpenAI 兼容服务)"}`);

try {
	const idx = await api.describeIndex(CLS.topicId);
	if (!idx.Status) fail("CLS 主题未开启索引，无法回查");
} catch (e) {
	if (e instanceof ClsApiError) fail(`DescribeIndex 失败：${e.message}`);
	throw e;
}

// 导出器显式自建并注入：便于在 session 结束后确定性地 await flush（扩展默认的进程级共享导出器要等 beforeExit）
const options = {
	exporter: "cls" as const,
	endpoint: CLS.endpoint,
	topicId: CLS.topicId,
	secretId: CLS.secretId,
	secretKey: CLS.secretKey,
	serviceName,
	resourceAttributes: { "agentobs.verify.run": runId, "agentobs.verify.mode": "sdk-harness" },
	propagateTraceparent: true,
	debug: true,
};
const logs: string[] = [];
const logger = { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) };
const exporter = new ClsExporter(resolveConfig(options), logger);
const extension = createAgentObsExtension({ ...options, spanExporter: exporter, logger });

const prompt = REAL_LLM
	? "Use the read tool to read a.txt and b.txt in the current directory, then reply with both file contents."
	: "read a.txt and b.txt";
const t0 = Date.now();
// mock 与真实 provider 返回不同形状（前者多一个 llm），用显式变量而非联合类型窄化
let mockLlm: MockLLM | undefined;
let h: Awaited<ReturnType<typeof createRealHarness>>;
if (REAL_LLM) {
	h = await createRealHarness({ factories: [extension], provider: { name: "real", baseUrl: REAL_LLM.baseUrl, api: REAL_LLM.api, apiKey: "$REAL_LLM_API_KEY", modelId: REAL_LLM.model } });
} else {
	const mock = await createHarness({ factories: [extension] });
	mockLlm = mock.llm;
	h = mock;
	mockLlm.script(
		{ kind: "tools", calls: [{ id: "call_a", name: "read", args: { path: "a.txt" } }, { id: "call_b", name: "read", args: { path: "b.txt" } }] },
		{ kind: "text", text: "both files say hello" },
	);
}
await h.session.prompt(prompt);
const last = h.session.messages.at(-1) as { role?: string; content?: unknown } | undefined;
await h.close();
await exporter.shutdown(); // 确定性 flush
const elapsed = Date.now() - t0;

const traceparents: string[] = (mockLlm?.requests ?? []).map((r) => String(r.headers.traceparent ?? "")).filter(Boolean);
const stats = /cls exporter stopped sent=(\d+) failed=(\d+) dropped=(\d+)/.exec(logs.join("\n"));
const warnings = logs.filter((l) => /upload failed|spans? lost|queue full|不完整/i.test(l));
console.log(`\n▶ prompt 完成 ${elapsed}ms  ${stats ? `cls sent=${stats[1]} failed=${stats[2]} dropped=${stats[3]}` : "未捕获上报统计"}`);
console.log(`  最终消息: role=${last?.role} content=${String(typeof last?.content === "string" ? last.content : JSON.stringify(last?.content)).slice(0, 120).replace(/\n/g, " ")}`);

// ── 回查 ──────────────────────────────────────────────────
type SpanRow = CLSSpan & { raw: Record<string, string> };
function rowToSpan(row: Record<string, string>): SpanRow {
	let attribute: Record<string, string | number | boolean> = {};
	try {
		attribute = JSON.parse(row.attribute ?? "{}") as Record<string, string | number | boolean>;
	} catch {
		// 非 JSON 时按空对象处理
	}
	return { ...(row as unknown as CLSSpan), attribute, raw: row };
}

console.log(`\n━━━━ CLS 回查（最多等待 ${WAIT_MS / 1000}s）`);
const from = t0 - 120_000;
// mock 模式下可直接从注入的 traceparent 取 traceId；真实模型没有注入，留空走 runId 检索
let traceId: string | undefined = traceparents[0]?.split("-")[1];
let spans: SpanRow[] = [];
const deadline = Date.now() + WAIT_MS;
while (!traceId && Date.now() < deadline) {
	const rows = await api.search(CLS.topicId, `"${runId}"`, from, Date.now() + 60_000);
	traceId = rows.map(rowToSpan).find((s) => s.attribute["agentobs.verify.run"] === runId)?.traceID;
	if (!traceId) await sleep(3000);
}
let stable = 0;
while (traceId && Date.now() < deadline) {
	const rows = await api.search(CLS.topicId, `traceID:"${traceId}"`, from, Date.now() + 60_000);
	const next = rows.map(rowToSpan);
	if (next.length > 0 && next.length === spans.length) {
		if (++stable >= 2) break;
	} else stable = 0;
	spans = next;
	await sleep(3000);
}
const seen = new Map<string, SpanRow>();
for (const s of spans) seen.set(s.spanID, s);
spans = [...seen.values()];

const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = "") => results.push([name, ok, detail]);
const of = (k: string) => spans.filter((s) => s.spanKind === k);
check("session 正常完成（最终消息为 assistant）", last?.role === "assistant");
check("扩展无告警", warnings.length === 0, warnings.slice(0, 2).join(" | "));
check("CLS 上报统计 failed=0 dropped=0", !!stats && stats[2] === "0" && stats[3] === "0", stats ? `sent=${stats[1]}` : "未捕获");
check("回查到 trace", !!traceId, traceId ?? "超时");
check("5 层 span 均存在", ["entry", "agent", "step", "chat", "tool"].every((k) => of(k).length > 0), JSON.stringify(Object.fromEntries(["entry", "agent", "step", "chat", "tool"].map((k) => [k, of(k).length]))));
const ids = new Set(spans.map((s) => s.spanID));
check("父子关系完整（无孤儿 span）", spans.length > 0 && spans.every((s) => s.spanKind === "entry" || ids.has(s.parentSpanID)));
check("service 为 SDK 内嵌时传入的值", of("entry")[0]?.service === serviceName, of("entry")[0]?.service ?? "");
check("resourceAttributes 落库", of("entry")[0]?.attribute["agentobs.verify.mode"] === "sdk-harness");
check("tool 结果含真实文件内容", of("tool").some((s) => String(s.attribute["gen_ai.tool.call.result"] ?? "").includes("hello from a")));
check("chat 有 usage 与 response.model", of("chat").length > 0 && of("chat").every((s) => Number(s.attribute["gen_ai.usage.input_tokens"]) > 0 && !!s.attribute["gen_ai.response.model"]));
if (traceparents.length) {
	const chatIds = new Set(of("chat").map((s) => `00-${s.traceID}-${s.spanID}-01`));
	check("注入 LLM 的 traceparent 与 chat span 一致", traceparents.every((t) => chatIds.has(t)), `${traceparents.length} 个请求`);
}

console.log(`\n■ SDK 内嵌模式  ${results.every(([, ok]) => ok) ? "PASS" : "FAIL"}${traceId ? `  traceID=${traceId}` : ""}`);
for (const [name, ok, detail] of results) console.log(`  ${ok ? "✔" : "✖"} ${name}${detail ? `  (${detail})` : ""}`);
if (spans.length) console.log(renderTrees(spans).split("\n").map((l) => `    ${l}`).join("\n"));

const out = path.join(ROOT, ".tmp", "real", `harness-${runId}.json`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ runId, mode: "sdk-harness", serviceName, traceId, llm: REAL_LLM ? { host: new URL(REAL_LLM.baseUrl).host, model: REAL_LLM.model } : "mock", checks: results.map(([n, ok, d]) => ({ name: n, ok, detail: d })), spans: spans.map(({ raw: _raw, ...s }) => s) }, null, 2));
console.log(`\n报告: ${path.relative(ROOT, out)}    CLS 检索：traceID:"${traceId}" 或 "${runId}"`);
process.exit(results.every(([, ok]) => ok) ? 0 : 1);
