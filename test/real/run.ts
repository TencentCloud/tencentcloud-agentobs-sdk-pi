// 真实环境端到端验证：
//   真实 pi CLI 进程（node_modules 里的 pi@1.3.0，隔离的 PI_CODING_AGENT_DIR）
//   → 以用户真实方式安装的本扩展（默认 npm pack 出 tgz 再 `pi install npm:<tgz>`）
//   → 真实 CLS 上报（CLS_* 环境变量）
//   → 通过 CLS 云 API SearchLog 回查，校验 span 树完整性与关键属性。
// LLM：配置 REAL_LLM_* 时走真实模型；否则用本进程内的 OpenAI 兼容 mock（可脚本化重试/工具报错等场景）。
// 可选：配置 REAL_OTLP_ENDPOINT 时追加一个 OTLP 通道用例，同样回查 CLS。
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import type { AttrValue, CLSSpan } from "../../src/span.ts";
import { MockLLM, type Step } from "../e2e/mock-server.ts";
import { renderTrees } from "../e2e/tree.ts";
import { ClsApi, ClsApiError, regionFromEndpoint } from "./cls-api.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
const PI_CLI = path.join(ROOT, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");

const { values: argv } = parseArgs({
	options: {
		install: { type: "string", default: "pack" }, // pack | dir | ext
		cases: { type: "string" }, // 逗号分隔，默认全部
		"wait-sec": { type: "string", default: "120" },
		"pi-timeout-sec": { type: "string", default: "180" },
	},
});
function fail(msg: string): never {
	console.error(`✖ ${msg}`);
	process.exit(2);
}
function requireEnv(name: string): string {
	const v = process.env[name]?.trim();
	if (!v) fail(`missing env ${name}`);
	return v;
}
function validateHttpsUrl(raw: string, name: string): string {
	let u: URL;
	try {
		u = new URL(raw.trim());
	} catch {
		fail(`${name} is not a valid URL`);
	}
	if (u.protocol !== "https:") fail(`${name} must be https://`);
	return u.toString();
}
function validateLlmUrl(raw: string): string {
	const u = new URL(raw.trim());
	const local = u.hostname === "127.0.0.1" || u.hostname === "localhost";
	if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) fail("REAL_LLM_BASE_URL must be https:// (http only for localhost)");
	return u.toString().replace(/\/+$/, "");
}
const mask = (s: string) => (s.length <= 8 ? "***" : `${s.slice(0, 4)}…${s.slice(-4)}`);

const INSTALL = argv.install as "pack" | "dir" | "ext";
if (!["pack", "dir", "ext"].includes(INSTALL)) fail(`--install must be pack|dir|ext, got ${INSTALL}`);
const WAIT_MS = Number(argv["wait-sec"]) * 1000;
const PI_TIMEOUT_MS = Number(argv["pi-timeout-sec"]) * 1000;

// ── 环境检查（fail-fast，不提供任何默认凭据） ─────────────────────
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
	? {
			baseUrl: validateLlmUrl(process.env.REAL_LLM_BASE_URL),
			model: requireEnv("REAL_LLM_MODEL"),
			api: process.env.REAL_LLM_API?.trim() || "openai-completions",
		}
	: undefined;
if (REAL_LLM) requireEnv("REAL_LLM_API_KEY");
/**
 * OTLP 验证目标。默认复用 CLS 自带的 OTLP/HTTP 接入点（同一套凭据、同一个主题），
 * 这样两条通道的数据可以在一个主题里对照，也不需要额外搭 Collector：
 *   POST https://<region>.cls.tencentc[sy]*.com/v1/traces
 *   Authorization: Basic base64(SecretId:SecretKey)
 *   topic_id: <topicId>
 * 需要发往自建 Collector / 其他后端时用 REAL_OTLP_ENDPOINT 覆盖。
 */
const basicAuth = Buffer.from(`${CLS.secretId}:${CLS.secretKey}`).toString("base64");
const OTLP = (() => {
	if (process.env.REAL_OTLP_ENDPOINT) {
		return {
			endpoint: validateHttpsUrl(process.env.REAL_OTLP_ENDPOINT, "REAL_OTLP_ENDPOINT"),
			headers: process.env.REAL_OTLP_HEADERS ?? "",
			topicId: process.env.REAL_OTLP_TOPIC_ID?.trim() || CLS.topicId,
			via: "custom" as const,
		};
	}
	if (process.env.REAL_OTLP === "0") return undefined;
	const host = CLS.endpoint.replace(/^https?:\/\//i, "").split(/[/:]/)[0] ?? "";
	// 仅允许 CLS 官方接入域名，避免把凭据发往任意 host
	if (!/\.cls\.tencent(cs|yun)\.com$/i.test(host)) return undefined;
	return { endpoint: `https://${host}/v1/traces`, headers: `Authorization=Basic ${basicAuth},topic_id=${CLS.topicId}`, topicId: CLS.topicId, via: "cls" as const };
})();

// ── 工具函数 ────────────────────────────────────────────────
interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
	ms: number;
}
function run(cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<ExecResult> {
	const t0 = Date.now();
	return new Promise((resolve) => {
		const child = execFile(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, timeout: opts.timeoutMs ?? 300_000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
			const code = typeof (err as NodeJS.ErrnoException | null)?.code === "number" ? Number((err as NodeJS.ErrnoException).code) : err ? 1 : 0;
			resolve({ code, stdout: String(stdout), stderr: String(stderr), ms: Date.now() - t0 });
		});
		// pi -p 会读取管道 stdin 作为附加输入，必须立即 EOF
		child.stdin?.end();
	});
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** 与 CLS 无关的敏感信息不应出现在日志里：输出 pi stderr 前做一次脱敏 */
function redact(s: string): string {
	let out = s;
	for (const v of [CLS.secretKey, CLS.secretId, basicAuth, process.env.REAL_LLM_API_KEY, process.env.CLS_TOKEN]) if (v && v.length >= 6) out = out.split(v).join("***");
	return out;
}

/** 回查结果：CLS 里的一条日志还原成 span，并保留原始字段用于校验顶层 schema */
type SpanRow = CLSSpan & { raw: Record<string, string> };

function rowToSpan(row: Record<string, string>): SpanRow {
	let attribute: Record<string, AttrValue> = {};
	try {
		attribute = JSON.parse(row.attribute ?? "{}") as Record<string, AttrValue>;
	} catch {
		// attribute 非 JSON 时按空对象处理
	}
	const spanKind = (row.spanKind || String(attribute["gen_ai.span.kind"] ?? "")).toLowerCase();
	return {
		...(row as unknown as CLSSpan),
		spanKind: spanKind as CLSSpan["spanKind"],
		attribute,
		durationMs: row.durationMs ?? String(Math.round(Number(row.duration ?? 0) / 1e6)),
		raw: row,
	};
}

// ── 用例 ──────────────────────────────────────────────────
type Kind = "entry" | "agent" | "step" | "chat" | "tool";
interface Ctx {
	spans: CLSSpan[];
	stdout: string;
	traceparents: string[];
}
interface Case {
	name: string;
	prompt: string;
	script?: Step[];
	exporter: "cls" | "otlp";
	/** exact=true 时要求数量完全一致（mock 场景），否则为下限（真实 LLM 行为不可控） */
	expect: Partial<Record<Kind, number>>;
	exact: boolean;
	checks: Array<[string, (c: Ctx) => boolean]>;
}

const kinds = (c: Ctx, k: Kind) => c.spans.filter((s) => s.spanKind === k);
const attr = (s: CLSSpan | undefined, k: string): AttrValue | undefined => s?.attribute?.[k];
/** CLS 直传写 OK/ERROR，CLS 的 OTLP 接入侧写 unset/error（小写），统一按大写比较 */
const isErr = (s: CLSSpan | undefined) => String(s?.statusCode ?? "").toUpperCase() === "ERROR";

const twoReads: Step = { kind: "tools", calls: [{ id: "call_a", name: "read", args: { path: "a.txt" } }, { id: "call_b", name: "read", args: { path: "b.txt" } }] };
const MOCK_CASES: Case[] = [
	{
		name: "parallel-tools",
		prompt: "read a.txt and b.txt",
		script: [twoReads, { kind: "text", text: "both files say hello" }],
		exporter: "cls",
		expect: { entry: 1, agent: 1, step: 2, chat: 2, tool: 2 },
		exact: true,
		checks: [
			["stdout 含最终回复", (c) => c.stdout.includes("both files say hello")],
			["tool 结果含文件内容", (c) => kinds(c, "tool").some((t) => String(attr(t, "gen_ai.tool.call.result")).includes("hello from a")) && kinds(c, "tool").some((t) => String(attr(t, "gen_ai.tool.call.result")).includes("hello from b"))],
			["chat 有 usage", (c) => kinds(c, "chat").every((s) => Number(attr(s, "gen_ai.usage.input_tokens")) > 0 && Number(attr(s, "gen_ai.usage.output_tokens")) > 0)],
			["chat 有 response.model / provider request id", (c) => kinds(c, "chat").every((s) => attr(s, "gen_ai.response.model") && attr(s, "pi.provider.request_id"))],
		],
	},
	{
		name: "retry-503",
		prompt: "hi",
		script: [{ kind: "http_error", status: 503 }, { kind: "text", text: "ok after retry" }],
		exporter: "cls",
		expect: { entry: 1, agent: 1, step: 2, chat: 2 },
		exact: true,
		checks: [
			["stdout 含重试后回复", (c) => c.stdout.includes("ok after retry")],
			["失败 chat 为 ERROR 且 status=503", (c) => kinds(c, "chat").some((s) => isErr(s) && Number(attr(s, "http.response.status_code")) === 503)],
			["agent attempts=2 retries=1", (c) => Number(attr(kinds(c, "agent")[0], "pi.agent.attempts")) === 2 && Number(attr(kinds(c, "agent")[0], "pi.agent.retries")) === 1],
			["entry 最终成功", (c) => !isErr(kinds(c, "entry")[0])],
		],
	},
	{
		name: "tool-error",
		prompt: "read missing.txt",
		script: [{ kind: "tools", calls: [{ id: "call_x", name: "read", args: { path: "missing.txt" } }] }, { kind: "text", text: "file missing" }],
		exporter: "cls",
		expect: { entry: 1, agent: 1, step: 2, chat: 2, tool: 1 },
		exact: true,
		checks: [["tool error.type=ToolError", (c) => attr(kinds(c, "tool")[0], "error.type") === "ToolError" && isErr(kinds(c, "tool")[0])]],
	},
];
const traceparentCheck: [string, (c: Ctx) => boolean] = [
	"LLM 收到的 traceparent 与 CLS 中的 chat span 一致",
	(c) => {
		const chat = new Set(kinds(c, "chat").map((s) => `00-${s.traceID}-${s.spanID}-01`));
		return c.traceparents.length > 0 && c.traceparents.every((t) => chat.has(t));
	},
];
for (const c of MOCK_CASES) c.checks.push(traceparentCheck);

const REAL_CASES: Case[] = [
	{
		name: "real-llm-read",
		prompt: "Use the read tool to read the file a.txt in the current directory, then reply with its exact content and nothing else.",
		exporter: "cls",
		expect: { entry: 1, agent: 1, step: 1, chat: 1, tool: 1 },
		exact: false,
		checks: [
			["stdout 含文件内容", (c) => c.stdout.includes("hello from a")],
			["tool 结果含文件内容", (c) => kinds(c, "tool").some((t) => String(attr(t, "gen_ai.tool.call.result")).includes("hello from a"))],
			["chat 有 usage / response.model", (c) => kinds(c, "chat").every((s) => Number(attr(s, "gen_ai.usage.input_tokens")) > 0 && attr(s, "gen_ai.response.model"))],
			["chat 有首 token 耗时", (c) => kinds(c, "chat").every((s) => Number(attr(s, "gen_ai.response.time_to_first_token_ms")) >= 0)],
		],
	},
];

const baseCases = REAL_LLM ? REAL_CASES : MOCK_CASES;
const allCases: Case[] = [...baseCases];
// 每个场景再跑一遍 OTLP 通道：同一主题、同一套断言，便于两条通道逐项对照
if (OTLP) allCases.push(...baseCases.map((c) => ({ ...c, name: `${c.name}-otlp`, exporter: "otlp" as const })));
const selected = argv.cases ? new Set(argv.cases.split(",").map((s) => s.trim())) : undefined;
const CASES = selected ? allCases.filter((c) => selected.has(c.name)) : allCases;
if (CASES.length === 0) fail(`no case selected; available: ${allCases.map((c) => c.name).join(", ")}`);

// ── 环境搭建 ────────────────────────────────────────────────
const runId = randomBytes(8).toString("hex");
const serviceName = `pi-real-verify`;
const base = path.join(ROOT, ".tmp", "real", `${new Date().toISOString().replace(/[:.]/g, "-")}-${runId}`);
const agentDir = path.join(base, "agent");
const workDir = path.join(base, "work");
fs.mkdirSync(agentDir, { recursive: true });
fs.mkdirSync(workDir, { recursive: true });
fs.writeFileSync(path.join(workDir, "a.txt"), "hello from a\n");
fs.writeFileSync(path.join(workDir, "b.txt"), "hello from b\n");

console.log(`━━━━ 真实验证环境  run=${runId}`);
console.log(`  pi CLI      : ${path.relative(ROOT, PI_CLI)}`);
console.log(`  agentDir    : ${path.relative(ROOT, agentDir)}  (隔离，不触碰 ~/.pi)`);
console.log(`  安装方式    : ${INSTALL}`);
console.log(`  CLS         : ${CLS.endpoint}  topic=${mask(CLS.topicId)}  region=${region}  secretId=${mask(CLS.secretId)}`);
console.log(`  LLM         : ${REAL_LLM ? `real ${REAL_LLM.api} ${new URL(REAL_LLM.baseUrl).host} model=${REAL_LLM.model}` : "mock (本进程内 OpenAI 兼容服务)"}`);
if (OTLP) console.log(`  OTLP        : ${OTLP.via === "cls" ? "CLS 自带 OTLP/HTTP 接入点" : "自定义后端"} ${new URL(OTLP.endpoint).host}${new URL(OTLP.endpoint).pathname}  回查 topic=${mask(OTLP.topicId)}`);

// 回查前置条件：主题需要开启索引
try {
	const idx = await api.describeIndex(CLS.topicId);
	const keys = new Set(idx.Rule?.KeyValue?.KeyValues?.map((k) => k.Key) ?? []);
	if (!idx.Status) fail("CLS 主题未开启索引，无法回查（控制台 → 日志主题 → 索引配置）");
	console.log(`  索引        : 全文=${idx.Rule?.FullText ? "on" : "off"}  traceID 键值索引=${keys.has("traceID") ? "on" : "off"}`);
	if (!idx.Rule?.FullText && !keys.has("traceID")) fail("需要开启全文索引或 traceID 键值索引");
} catch (e) {
	if (e instanceof ClsApiError) fail(`DescribeIndex 失败：${e.message}（检查密钥是否有 cls:DescribeIndex / cls:SearchLog 权限）`);
	throw e;
}

const piEnvBase: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0" };
const extArgs: string[] = [];
if (INSTALL === "pack") {
	const r = await run("npm", ["pack", "--pack-destination", base, "--silent"], { cwd: ROOT });
	if (r.code !== 0) fail(`npm pack failed:\n${r.stderr}`);
	const tgz = path.join(base, r.stdout.trim().split("\n").pop()!.trim());
	if (!fs.existsSync(tgz)) fail(`npm pack output not found: ${tgz}`);
	const i = await run(process.execPath, [PI_CLI, "install", `npm:${tgz}`], { cwd: base, env: piEnvBase });
	if (i.code !== 0) fail(`pi install failed:\n${redact(i.stderr)}`);
	console.log(`  已安装      : pi install npm:${path.relative(ROOT, tgz)}  (${i.ms}ms，依赖从 registry 重新安装)`);
} else if (INSTALL === "dir") {
	const i = await run(process.execPath, [PI_CLI, "install", ROOT], { cwd: base, env: piEnvBase });
	if (i.code !== 0) fail(`pi install failed:\n${redact(i.stderr)}`);
	console.log(`  已安装      : pi install ${ROOT}`);
} else {
	const ext = path.join(ROOT, "dist", "extension.js");
	if (!fs.existsSync(ext)) fail("dist/extension.js not found, run npm run build first");
	extArgs.push("-e", ext);
}

const settingsPath = path.join(agentDir, "settings.json");
const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, "utf8")) : {};
if (INSTALL === "pack") {
	// pi@1.3.0 加载阶段用 parseNpmSpec 把 "npm:/abs/x.tgz" 整体当包名，找不到安装目录就静默跳过；
	// 改写为包名后，settings 与 npm/node_modules 布局和 `pi install npm:tencentcloud-agentobs-sdk-pi` 完全一致。
	const pkgName = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).name as string;
	if (!fs.existsSync(path.join(agentDir, "npm", "node_modules", pkgName, "package.json"))) fail(`package not found under ${agentDir}/npm/node_modules`);
	settings.packages = (settings.packages ?? []).map((p: unknown) => (typeof p === "string" && p.startsWith("npm:") && p.endsWith(".tgz") ? `npm:${pkgName}` : p));
}
Object.assign(settings, { compaction: { enabled: false }, retry: { enabled: true, maxRetries: 2, baseDelayMs: 200 }, quietStartup: true });
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

let llm: MockLLM | undefined;
let modelRef: string;
if (REAL_LLM) {
	// apiKey 用 $ENV 插值，密钥不落盘
	fs.writeFileSync(
		path.join(agentDir, "models.json"),
		JSON.stringify({ providers: { real: { baseUrl: REAL_LLM.baseUrl, api: REAL_LLM.api, apiKey: "$REAL_LLM_API_KEY", models: [{ id: REAL_LLM.model, name: REAL_LLM.model, contextWindow: 128000, maxTokens: 4096 }] } } }, null, 2),
	);
	modelRef = `real/${REAL_LLM.model}`;
} else {
	llm = new MockLLM();
	await llm.start();
	fs.writeFileSync(
		path.join(agentDir, "models.json"),
		JSON.stringify({ providers: { mock: { baseUrl: llm.url, api: "openai-completions", apiKey: "sk-mock", models: [{ id: "mock-gpt", name: "Mock GPT", contextWindow: 128000, maxTokens: 4096 }] } } }, null, 2),
	);
	modelRef = "mock/mock-gpt";
}

// ── 执行 ──────────────────────────────────────────────────
interface CaseRun {
	c: Case;
	res: ExecResult;
	loaded: boolean;
	traceparents: string[];
	stats?: { sent: number; failed: number; dropped: number };
	warnings: string[];
	startedAt: number;
}
const runs: CaseRun[] = [];
for (const c of CASES) {
	if (llm && c.script) llm.script(...c.script);
	const before = llm?.requests.length ?? 0;
	const env: NodeJS.ProcessEnv = {
		...piEnvBase,
		AGENTOBS_EXPORTER: c.exporter,
		AGENTOBS_DEBUG: "1",
		AGENTOBS_PROPAGATE_TRACEPARENT: llm ? "true" : "false",
		CLS_SERVICE_NAME: serviceName,
		OTEL_RESOURCE_ATTRIBUTES: `agentobs.verify.run=${runId},agentobs.verify.case=${c.name}`,
	};
	if (c.exporter === "otlp" && OTLP) {
		env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = OTLP.endpoint;
		env.OTEL_EXPORTER_OTLP_TRACES_HEADERS = OTLP.headers;
		env.OTEL_SERVICE_NAME = serviceName;
	}
	const args = [PI_CLI, ...extArgs, "-p", "--no-session", "--model", modelRef, "--thinking", "off", "--tools", "read", "-ns", "-np", "--no-themes", "-nc", "--no-mcp", "--", c.prompt];
	const startedAt = Date.now();
	process.stdout.write(`\n▶ ${c.name} [${c.exporter}] … `);
	const res = await run(process.execPath, args, { cwd: workDir, env, timeoutMs: PI_TIMEOUT_MS });
	const m = /(?:cls|otlp) exporter stopped sent=(\d+) failed=(\d+)(?: dropped=(\d+))?/.exec(res.stderr);
	const loaded = /\[agentobs-pi\] (?:cls|otlp) exporter (?:→|\()/.test(res.stderr);
	const warnings = res.stderr.split("\n").filter((l) => /\[agentobs-pi\].*(upload failed|spans? lost|queue full| failed:|不完整|unsupported)/i.test(l));
	const traceparents = (llm?.requests.slice(before) ?? []).map((r) => String(r.headers.traceparent ?? "")).filter(Boolean);
	runs.push({ c, res, loaded, traceparents, stats: m ? { sent: +m[1]!, failed: +m[2]!, dropped: +(m[3] ?? 0) } : undefined, warnings, startedAt });
	console.log(`exit=${res.code} ${res.ms}ms${m ? `  ${c.exporter} sent=${m[1]} failed=${m[2]}${m[3] ? ` dropped=${m[3]}` : ""}` : ""}${llm ? `  LLM 请求=${llm.requests.length - before}` : ""}`);
	if (res.code !== 0) console.log(redact(res.stderr).split("\n").slice(-15).map((l) => `    | ${l}`).join("\n"));
	if (llm && llm.pending > 0) {
		console.log(`    ! mock 脚本剩余 ${llm.pending} 步未消费`);
		llm.clear(); // 不影响后续用例
	}
}
await llm?.stop();

// ── 回查 ──────────────────────────────────────────────────
console.log(`\n━━━━ CLS 回查（最多等待 ${WAIT_MS / 1000}s 索引生效）`);
const from = runs[0]!.startedAt - 120_000;
async function searchTrace(topicId: string, traceId: string, to: number) {
	try {
		return await api.search(topicId, `traceID:"${traceId}"`, from, to);
	} catch (e) {
		if (e instanceof ClsApiError && /index|syntax/i.test(e.message)) return api.search(topicId, `"${traceId}"`, from, to);
		throw e;
	}
}
const expectedTotal = (c: Case) => Object.values(c.expect).reduce((a, b) => a + (b ?? 0), 0);

interface Verdict {
	name: string;
	ok: boolean;
	traceId?: string;
	lines: string[];
	spans: SpanRow[];
}
const verdicts: Verdict[] = [];
for (const r of runs) {
	const { c } = r;
	const topicId = c.exporter === "otlp" && OTLP ? OTLP.topicId : CLS.topicId;
	const v: Verdict = { name: c.name, ok: true, lines: [], spans: [] };
	const check = (name: string, ok: boolean, detail = "") => {
		v.lines.push(`  ${ok ? "✔" : "✖"} ${name}${detail ? `  (${detail})` : ""}`);
		if (!ok) v.ok = false;
	};
	check("pi 进程退出码 0", r.res.code === 0, `exit=${r.res.code}`);
	check("扩展已被 pi 加载（exporter 已启动）", r.loaded);
	check("扩展无告警", r.warnings.length === 0, r.warnings.slice(0, 3).map(redact).join(" | "));
	check(`${c.exporter.toUpperCase()} 上报统计 failed=0 dropped=0`, !!r.stats && r.stats.failed === 0 && r.stats.dropped === 0, r.stats ? `sent=${r.stats.sent}` : "未捕获到 debug 统计行");

	// 1) 由 runId + case 找到 traceID：mock 模式下 traceparent 直接给出；否则全文检索 entry span
	let traceId = r.traceparents[0]?.split("-")[1];
	const deadline = r.loaded ? Date.now() + WAIT_MS : 0;
	let spans: SpanRow[] = [];
	const caseOf = (s: SpanRow) => {
		if (attr(s, "agentobs.verify.case")) return attr(s, "agentobs.verify.case");
		try {
			return JSON.parse(s.raw.resource ?? "{}")["agentobs.verify.case"];
		} catch {
			return undefined;
		}
	};
	try {
		while (!traceId && Date.now() < deadline) {
			const rows = await api.search(topicId, `"${runId}"`, from, Date.now() + 60_000);
			traceId = rows.map(rowToSpan).find((s) => caseOf(s) === c.name)?.traceID;
			if (!traceId) await sleep(3000);
		}
		check("通过 runId 定位到 trace", !!traceId, traceId ?? (r.loaded ? "超时" : "扩展未加载，跳过"));
		// 2) 按 traceID 拉全量，直到数量达到预期（或稳定）
		let last = -1;
		let stable = 0;
		while (traceId && Date.now() < deadline) {
			spans = (await searchTrace(topicId, traceId, Date.now() + 60_000)).map(rowToSpan);
			if (spans.length >= expectedTotal(c) && (c.exact || spans.length === last)) {
				if (++stable >= (c.exact ? 1 : 2)) break;
			} else stable = 0;
			last = spans.length;
			await sleep(3000);
		}
	} catch (e) {
		check("CLS SearchLog 调用", false, e instanceof Error ? e.message : String(e));
	}
	const seen = new Map<string, SpanRow>();
	for (const s of spans) seen.set(s.spanID, s); // CLS 可能返回重复（重试上报）
	spans = [...seen.values()];
	v.spans = spans;
	v.traceId = traceId;
	if (traceId) {
		const counts = Object.fromEntries((["entry", "agent", "step", "chat", "tool"] as Kind[]).map((k) => [k, spans.filter((s) => s.spanKind === k).length]));
		const countOk = (Object.entries(c.expect) as [Kind, number][]).every(([k, n]) => (c.exact ? counts[k] === n : counts[k]! >= n));
		check(`span 数量${c.exact ? "" : "（下限）"} ${JSON.stringify(c.expect)}`, countOk, JSON.stringify(counts));
		const ids = new Set(spans.map((s) => s.spanID));
		const orphans = spans.filter((s) => s.spanKind !== "entry" && !ids.has(s.parentSpanID));
		check("父子关系完整（无孤儿 span）", spans.length > 0 && orphans.length === 0, orphans.map((s) => s.name).join(","));
		check("单一 sessionID", new Set(spans.map((s) => s.sessionID).filter(Boolean)).size <= 1);
		const entry = spans.find((s) => s.spanKind === "entry");
		const res: Record<string, string> = (() => {
			try {
				return JSON.parse(entry?.raw.resource ?? "{}") as Record<string, string>;
			} catch {
				return {};
			}
		})();
		check("service / resource 属性落库", (entry?.service === serviceName || res["service.name"] === serviceName) && (attr(entry, "agentobs.verify.run") === runId || res["agentobs.verify.run"] === runId));
		if (c.exporter === "cls") {
			const FIELDS = ["spanKind", "traceID", "spanID", "parentSpanID", "sessionID", "agentID", "parentAgentID", "stepID", "name", "kind", "statusCode", "statusMessage", "start", "end", "duration", "durationMs", "host", "service", "links", "attribute"];
			const missing = spans.flatMap((s) => FIELDS.filter((f) => !(f in s.raw)).map((f) => `${s.name}.${f}`));
			check("CLS 顶层字段齐全（与 dsh schema 一致）", missing.length === 0, missing.slice(0, 5).join(","));
		}
		const ctx: Ctx = { spans, stdout: r.res.stdout, traceparents: r.traceparents };
		for (const [name, fn] of c.checks) {
			let ok = false;
			try {
				ok = fn(ctx);
			} catch {}
			check(name, ok);
		}
	}
	verdicts.push(v);
	console.log(`\n■ ${c.name}  ${v.ok ? "PASS" : "FAIL"}${traceId ? `  traceID=${traceId}` : ""}`);
	console.log(v.lines.join("\n"));
	if (spans.length) console.log(renderTrees(spans).split("\n").map((l) => `    ${l}`).join("\n"));
}

// ── 跨通道一致性：同一场景分别走 cls / otlp，落库后的结构与关键属性应当等价 ──
interface CrossResult {
	name: string;
	ok: boolean;
	detail: string;
}
const cross: CrossResult[] = [];
if (OTLP) {
	// 结构指纹：按 (spanKind, name, 深度) 排序比较，忽略随机 id、耗时与大小写差异
	const signature = (spans: CLSSpan[]): string => {
		const byId = new Map(spans.map((s) => [s.spanID, s]));
		const depth = (s: CLSSpan): number => {
			let d = 0;
			let cur = s;
			while (cur.parentSpanID && byId.has(cur.parentSpanID) && d < 16) {
				cur = byId.get(cur.parentSpanID)!;
				d++;
			}
			return d;
		};
		return spans.map((s) => `${depth(s)}|${s.spanKind}|${s.name}|${isErr(s) ? "ERROR" : "OK"}`).sort().join("\n");
	};
	// 这些属性与通道无关；mock 场景下两边必须逐值一致
	const KEY_ATTRS = ["gen_ai.usage.input_tokens", "gen_ai.usage.output_tokens", "pi.agent.attempts", "pi.tool.calls", "pi.tool.errors", "http.response.status_code", "error.type"];
	const digest = (spans: CLSSpan[]): string =>
		spans
			.map((s) => `${s.spanKind}|${s.name}|${KEY_ATTRS.filter((k) => attr(s, k) !== undefined).map((k) => `${k}=${attr(s, k)}`).join(",")}`)
			.sort()
			.join("\n");
	/**
	 * 真实模型下两条通道是两次独立调用，token 数、轮次、span 名都会不同，逐值比较没有意义。
	 * 此时只比较「schema 等价」：出现的 span 层级相同，且每种层级携带的属性键集合相同。
	 */
	const kindSet = (spans: CLSSpan[]): string => [...new Set(spans.map((s) => s.spanKind))].sort().join(",");
	/**
	 * CLS 直传把 sessionID / agentID / stepID 放在顶层字段，OTLP 没有对应位置、按设计映射进
	 * attributes（见 src/otlp.ts toReadableSpan）。这是通道间的预期差异，比较属性键时排除。
	 */
	const MAPPED = new Set(["gen_ai.session.id", "gen_ai.agent.id", "gen_ai.step.id", "gen_ai.span.kind"]);
	const attrKeys = (spans: CLSSpan[]): string =>
		[...new Set(spans.map((s) => s.spanKind))]
			.sort()
			.map((k) => {
				const keys = new Set<string>();
				for (const s of spans.filter((x) => x.spanKind === k)) for (const a of Object.keys(s.attribute ?? {})) if (!MAPPED.has(a)) keys.add(a);
				return `${k}|${[...keys].sort().join(",")}`;
			})
			.join("\n");
	for (const v of verdicts) {
		if (v.name.endsWith("-otlp")) continue;
		const twin = verdicts.find((x) => x.name === `${v.name}-otlp`);
		if (!twin || v.spans.length === 0 || twin.spans.length === 0) continue;
		const exact = CASES.find((c) => c.name === v.name)?.exact ?? true;
		if (exact) {
			const structOk = signature(v.spans) === signature(twin.spans);
			const attrOk = digest(v.spans) === digest(twin.spans);
			cross.push({ name: v.name, ok: structOk && attrOk, detail: structOk ? (attrOk ? `${v.spans.length} spans 结构与关键属性一致` : "结构一致但关键属性不同") : "结构不同" });
		} else {
			const structOk = kindSet(v.spans) === kindSet(twin.spans);
			const schemaOk = attrKeys(v.spans) === attrKeys(twin.spans);
			cross.push({
				name: v.name,
				ok: structOk && schemaOk,
				detail: `真实模型：只比 schema（cls ${v.spans.length} spans / otlp ${twin.spans.length} spans）${structOk ? "" : "，span 层级集合不同"}${schemaOk ? "" : "，属性键集合不同"}${structOk && schemaOk ? "，层级与属性键一致" : ""}`,
			});
		}
	}
	if (cross.length) {
		console.log(`\n━━━━ 跨通道一致性（CLS 直传 vs OTLP/HTTP）`);
		for (const x of cross) console.log(`  ${x.ok ? "✔" : "✖"} ${x.name}  ${x.detail}`);
	}
}

const report = {
	runId,
	region,
	topicId: mask(CLS.topicId),
	install: INSTALL,
	llm: REAL_LLM ? { api: REAL_LLM.api, host: new URL(REAL_LLM.baseUrl).host, model: REAL_LLM.model } : "mock",
	otlp: OTLP ? { via: OTLP.via, host: new URL(OTLP.endpoint).host, path: new URL(OTLP.endpoint).pathname } : null,
	cases: verdicts.map((v) => ({ name: v.name, ok: v.ok, traceId: v.traceId, checks: v.lines.map((l) => l.trim()), spans: v.spans.map(({ raw: _raw, ...s }) => s) })),
	crossChannel: cross,
};
fs.writeFileSync(path.join(base, "report.json"), JSON.stringify(report, null, 2));
const passed = verdicts.filter((v) => v.ok).length;
const crossOk = cross.every((x) => x.ok);
console.log(`\n━━━━ 结果 ${passed}/${verdicts.length} PASS${cross.length ? `，跨通道一致性 ${cross.filter((x) => x.ok).length}/${cross.length}` : ""}   报告: ${path.relative(ROOT, path.join(base, "report.json"))}`);
console.log(`CLS 控制台检索：traceID:"<id>" 或 "${runId}"`);
process.exit(passed === verdicts.length && crossOk ? 0 : 1);
