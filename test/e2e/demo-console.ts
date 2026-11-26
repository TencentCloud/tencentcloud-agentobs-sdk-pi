// 端到端演示：以“文件扩展”方式加载 dist/extension.js（与用户真实安装路径一致），
// 用 console 导出器把 span 写入 JSONL，再还原成调用树打印。
import fs from "node:fs";
import path from "node:path";
import { createHarness } from "./harness.ts";
import { renderTrees } from "./tree.ts";

const root = path.resolve(import.meta.dirname, "../..");
const spansFile = path.join(root, ".tmp", `spans-${Date.now()}.jsonl`);
fs.mkdirSync(path.dirname(spansFile), { recursive: true });
process.env.AGENTOBS_EXPORTER = "console";
process.env.AGENTOBS_CONSOLE_FILE = spansFile;
process.env.AGENTOBS_PROPAGATE_TRACEPARENT = "true";
const extPath = path.join(root, "dist", "extension.js");

const twoReads = { kind: "tools", calls: [{ id: "call_a", name: "read", args: { path: "a.txt" } }, { id: "call_b", name: "read", args: { path: "b.txt" } }] } as const;
const err503 = { kind: "http_error", status: 503 } as const;

async function run(title: string, script: any[], prompt: string, extra: { abortAfterMs?: number; settings?: any } = {}) {
	const before = fs.existsSync(spansFile) ? fs.readFileSync(spansFile, "utf8").split("\n").filter(Boolean).length : 0;
	const h = await createHarness({ extensionPaths: [extPath], settings: extra.settings });
	h.llm.script(...script);
	if (extra.abortAfterMs) setTimeout(() => void h.session.abort(), extra.abortAfterMs);
	await h.session.prompt(prompt);
	await h.close(); // dispose → session_shutdown → flush
	const lines = fs.readFileSync(spansFile, "utf8").split("\n").filter(Boolean).slice(before);
	const spans = lines.map((l) => JSON.parse(l));
	console.log(`\n━━━━ ${title} ━━━━  HTTP=${h.llm.requests.length}`);
	console.log(renderTrees(spans));
	// traceparent 注入核对：mock 服务器收到的 header 应等于对应 chat span
	const tps = h.llm.requests.map((r) => r.headers.traceparent).filter(Boolean);
	const chatIds = new Set(spans.filter((s: any) => s.spanKind === "chat").map((s: any) => `00-${s.traceID}-${s.spanID}-01`));
	console.log(`  traceparent 注入: ${tps.length}/${h.llm.requests.length} 个请求带头，与 chat span 匹配 ${tps.filter((t) => chatIds.has(t as string)).length} 个`);
	return spans;
}

await run("A 正常：并行 2 个工具", [twoReads, { kind: "text", text: "both files say hello" }], "read a.txt and b.txt");
await run("B agent 级重试：503 → 成功", [err503, { kind: "text", text: "ok after retry" }], "hi");
await run("F 工具报错", [{ kind: "tools", calls: [{ id: "call_x", name: "read", args: { path: "missing.txt" } }] }, { kind: "text", text: "file missing" }], "read missing.txt");
await run("D 不可重试 400", [{ kind: "http_error", status: 400, body: JSON.stringify({ error: { message: "bad request" } }) }], "hi");
console.log(`\nspans 原始 JSONL: ${spansFile}`);
