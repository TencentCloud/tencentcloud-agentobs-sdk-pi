// CLS 直传链路：真实 pi session → 本扩展（exporter=cls）→ tencentcloud-cls-sdk-js → 本地 mock CLS。
// 校验 URL/topic、签名头、压缩、protobuf 内容可还原为完整 span 树；以及 endpoint 默认 https、上报失败不影响 agent。
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import zlib from "node:zlib";
import { describe, test } from "node:test";
import { type CLSSpan, createAgentObsExtension, normalizeEndpoint, resolveConfig } from "../../dist/index.js";
import { createHarness } from "./harness.ts";

const require = createRequire(import.meta.url);
const { LogGroup } = require("tencentcloud-cls-sdk-js");

interface Received {
	url: string;
	headers: http.IncomingHttpHeaders;
	logs: Array<{ time: number; fields: Record<string, string> }>;
}

async function startMockCls(status = 200) {
	const received: Received[] = [];
	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			const raw = zlib.inflateRawSync(Buffer.concat(chunks));
			const decoded = new LogGroup().decode(raw);
			const logs = decoded.logGroupList.flatMap((g: any) =>
				g.logs.map((l: any) => ({ time: Number(l.time), fields: Object.fromEntries(l.contents.map((c: any) => [c.key, c.value])) })),
			);
			received.push({ url: req.url ?? "", headers: req.headers, logs });
			res.writeHead(status, { "x-cls-requestid": `cls-${received.length}` });
			res.end();
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const port = (server.address() as AddressInfo).port;
	return { received, url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const toSpan = (f: Record<string, string>) => ({ ...f, attribute: JSON.parse(f.attribute ?? "{}") }) as unknown as CLSSpan;

async function waitFor(cond: () => boolean, ms = 5000) {
	const end = Date.now() + ms;
	while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
}

describe("CLS exporter", () => {
	test("endpoint 规范化：缺省补 https://，显式 http:// 保留，去尾斜杠", () => {
		assert.equal(normalizeEndpoint("ap-guangzhou.cls.tencentcs.com"), "https://ap-guangzhou.cls.tencentcs.com");
		assert.equal(normalizeEndpoint("HTTPS://ap-guangzhou.cls.tencentcs.com/"), "https://ap-guangzhou.cls.tencentcs.com");
		assert.equal(normalizeEndpoint("http://127.0.0.1:8080"), "http://127.0.0.1:8080");
		assert.equal(normalizeEndpoint(""), "");
		const cfg = resolveConfig({}, { CLS_ENDPOINT: "ap-shanghai.cls.tencentcs.com", CLS_TOPIC_ID: "t", CLS_SECRET_ID: "a", CLS_SECRET_KEY: "b" });
		assert.equal(cfg.exporter, "cls");
		assert.equal(cfg.endpoint, "https://ap-shanghai.cls.tencentcs.com");
	});

	test("配置不完整时降级为 none 并列出缺失项", () => {
		const cfg = resolveConfig({}, { AGENTOBS_EXPORTER: "cls", CLS_ENDPOINT: "x" });
		assert.equal(cfg.exporter, "none");
		assert.deepEqual(cfg.missing, ["CLS_TOPIC_ID", "CLS_SECRET_ID + CLS_SECRET_KEY (or CLS_UIN)"]);
		assert.equal(resolveConfig({}, {}).exporter, "none");
	});

	test("真实 session → PutLogs：topic/签名/压缩/protobuf 正确，span 树完整", async () => {
		const cls = await startMockCls();
		const warns: string[] = [];
		const ext = createAgentObsExtension({
			exporter: "cls",
			endpoint: cls.url,
			topicId: "topic-e2e",
			secretId: "AKIDtest",
			secretKey: "secret-test",
			serviceName: "pi-e2e",
			resourceAttributes: { "deployment.environment": "test" },
			logger: { info() {}, warn: (m) => warns.push(m) },
		});
		const h = await createHarness({ factories: [ext] });
		h.llm.script(
			{ kind: "tools", calls: [{ id: "call_a", name: "read", args: { path: "a.txt" } }] },
			{ kind: "text", text: "done" },
		);
		await h.session.prompt("read a.txt");
		await h.close();
		await waitFor(() => cls.received.reduce((n, r) => n + r.logs.length, 0) >= 7);
		await cls.close();

		assert.deepEqual(warns, []);
		assert.ok(cls.received.length >= 1);
		for (const req of cls.received) {
			assert.equal(req.url, "/structuredlog?topic_id=topic-e2e");
			assert.match(String(req.headers.authorization), /^q-sign-algorithm=sha1&q-ak=AKIDtest&/);
			assert.equal(req.headers["content-type"], "application/x-protobuf");
			assert.match(String(req.headers["user-agent"]), /agentobs-pi-0\.1\.0/);
		}

		const logs = cls.received.flatMap((r) => r.logs);
		const spans = logs.map((l) => toSpan(l.fields));
		// entry + agent + step×2 + chat×2 + tool×1
		assert.deepEqual(spans.map((s) => s.spanKind).sort(), ["agent", "chat", "chat", "entry", "step", "step", "tool"]);
		// 每条日志的 time（秒）= span.start（纳秒）/ 1e9
		for (const l of logs) assert.equal(l.time, Number(BigInt(l.fields.start!) / 1_000_000_000n));
		// 顶层字段齐全（与 dsh 版 CLS schema 一致）
		const FIELDS = ["spanKind", "traceID", "spanID", "parentSpanID", "sessionID", "agentID", "parentAgentID", "stepID", "name", "kind", "statusCode", "statusMessage", "start", "end", "duration", "durationMs", "host", "service", "links", "attribute"];
		for (const l of logs) assert.deepEqual(Object.keys(l.fields).sort(), [...FIELDS].sort());
		// 树结构经过序列化后仍然完整
		const byId = new Map(spans.map((s) => [s.spanID, s]));
		for (const s of spans) if (s.spanKind !== "entry") assert.ok(byId.has(s.parentSpanID), `${s.name} orphan after CLS round-trip`);
		const entry = spans.find((s) => s.spanKind === "entry")!;
		assert.equal(entry.service, "pi-e2e");
		assert.equal((entry.attribute as any)["deployment.environment"], "test");
		const tool = spans.find((s) => s.spanKind === "tool")!;
		assert.match(String((tool.attribute as any)["gen_ai.tool.call.result"]), /hello from a/);
	});

	test("CLS 返回 500：只告警不抛错，agent 正常完成", async () => {
		const cls = await startMockCls(500);
		const warns: string[] = [];
		const ext = createAgentObsExtension({
			exporter: "cls",
			endpoint: cls.url,
			topicId: "topic-e2e",
			secretId: "AKIDtest",
			secretKey: "secret-test",
			retryTimes: 2,
			logger: { info() {}, warn: (m) => warns.push(m) },
		});
		const h = await createHarness({ factories: [ext] });
		h.llm.script({ kind: "text", text: "fine" });
		await h.session.prompt("hi");
		const last = h.session.messages.at(-1) as any;
		assert.equal(last?.role, "assistant");
		assert.equal(last?.stopReason, "stop");
		await h.close();
		await waitFor(() => warns.length > 0);
		await cls.close();
		assert.equal(cls.received.length, 2, "SDK retried retryTimes=2 times");
		assert.match(warns.join("\n"), /upload failed .* 4 spans lost/);
	});
});
