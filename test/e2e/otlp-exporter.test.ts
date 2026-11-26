// OTLP 链路：真实 pi session → 本扩展（exporter=otlp）→ 官方 @opentelemetry/exporter-trace-otlp-proto|-http → 本地 mock Collector。
// 校验 /v1/traces、protobuf（默认）/ JSON 编码、resource/scope、traceId/parentSpanId 树、SpanKind/Status 映射、属性完整，
// 以及“文件扩展 + 纯环境变量”配置路径（等价于 pi install 后只设 OTEL_* 变量）。
// protobuf 用独立的 protobufjs + 按 opentelemetry-proto 字段号手写的 schema 解码，不复用被测库的 serializer。
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import zlib from "node:zlib";
import { describe, test } from "node:test";
import protobuf from "protobufjs";
import { createAgentObsExtension, resolveConfig } from "../../dist/index.js";
import { createHarness } from "./harness.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
const EXT_PATH = path.join(ROOT, "dist", "extension.js");

// opentelemetry-proto v1：collector/trace/v1/trace_service.proto + trace/v1/trace.proto + common/resource 的子集（字段号与官方一致）
const OTLP_PROTO = `
syntax = "proto3";
package otlp;
message ExportTraceServiceRequest { repeated ResourceSpans resource_spans = 1; }
message ResourceSpans { Resource resource = 1; repeated ScopeSpans scope_spans = 2; string schema_url = 3; }
message Resource { repeated KeyValue attributes = 1; uint32 dropped_attributes_count = 2; }
message ScopeSpans { InstrumentationScope scope = 1; repeated Span spans = 2; string schema_url = 3; }
message InstrumentationScope { string name = 1; string version = 2; repeated KeyValue attributes = 3; }
message Span {
  bytes trace_id = 1; bytes span_id = 2; string trace_state = 3; bytes parent_span_id = 4;
  string name = 5; int32 kind = 6; fixed64 start_time_unix_nano = 7; fixed64 end_time_unix_nano = 8;
  repeated KeyValue attributes = 9; uint32 dropped_attributes_count = 10; Status status = 15; fixed32 flags = 16;
}
message Status { string message = 2; int32 code = 3; }
message KeyValue { string key = 1; AnyValue value = 2; }
message AnyValue { oneof value { string string_value = 1; bool bool_value = 2; int64 int_value = 3; double double_value = 4; bytes bytes_value = 7; } }
`;
const ExportTraceServiceRequest = protobuf.parse(OTLP_PROTO).root.lookupType("otlp.ExportTraceServiceRequest");
const hex = (b: unknown) => (b instanceof Uint8Array && b.length > 0 ? Buffer.from(b).toString("hex") : undefined);

interface OtlpSpan {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
	kind: number;
	startTimeUnixNano: string | number;
	endTimeUnixNano: string | number;
	status?: { code?: number; message?: string };
	attributes: Record<string, unknown>;
	resource: Record<string, unknown>;
	scope: { name?: string; version?: string };
}

const anyValue = (v: any): unknown => v?.stringValue ?? (v?.intValue !== undefined ? Number(v.intValue) : undefined) ?? v?.doubleValue ?? v?.boolValue;
const kv = (list: any[] = []) => Object.fromEntries(list.map((a) => [a.key, anyValue(a.value)]));

/** 把 protobuf / JSON 两种编码统一解码成同一结构（ids 统一为小写 hex） */
function decodeBody(raw: Buffer, contentType: string): any {
	if (contentType.startsWith("application/x-protobuf")) {
		const obj = ExportTraceServiceRequest.toObject(ExportTraceServiceRequest.decode(raw), { longs: String }) as any;
		for (const rs of obj.resourceSpans ?? [])
			for (const ss of rs.scopeSpans ?? [])
				for (const s of ss.spans ?? []) {
					s.traceId = hex(s.traceId);
					s.spanId = hex(s.spanId);
					s.parentSpanId = hex(s.parentSpanId);
				}
		return obj;
	}
	if (contentType.startsWith("application/json")) return JSON.parse(raw.toString("utf8"));
	throw new Error(`unexpected content-type ${contentType}`);
}

async function startCollector(status = 200) {
	const requests: Array<{ url: string; headers: http.IncomingHttpHeaders; bytes: number }> = [];
	const spans: OtlpSpan[] = [];
	const errors: unknown[] = [];
	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			let raw = Buffer.concat(chunks);
			requests.push({ url: req.url ?? "", headers: req.headers, bytes: raw.length });
			const ct = String(req.headers["content-type"] ?? "");
			try {
				if (req.headers["content-encoding"] === "gzip") raw = zlib.gunzipSync(raw);
				if (status === 200) {
					const body = decodeBody(raw, ct);
					for (const rs of body.resourceSpans ?? []) {
						const resource = kv(rs.resource?.attributes);
						for (const ss of rs.scopeSpans ?? [])
							for (const s of ss.spans ?? []) spans.push({ ...s, attributes: kv(s.attributes), resource, scope: ss.scope ?? {} });
					}
				}
			} catch (e) {
				errors.push(e);
			}
			// 响应编码跟随请求：protobuf 返回空的 ExportTraceServiceResponse（0 字节）
			res.writeHead(status, { "content-type": ct || "application/json" });
			res.end(ct.startsWith("application/json") ? (status === 200 ? "{}" : JSON.stringify({ code: 3, message: "bad payload" })) : "");
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return { base, requests, spans, errors, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function waitFor(cond: () => boolean, ms = 8000) {
	const end = Date.now() + ms;
	while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
}

// OTLP proto 枚举：SpanKind = API 值 + 1；Status OK=1 ERROR=2
const KIND = { INTERNAL: 1, SERVER: 2, CLIENT: 3 };

describe("OTLP exporter (@opentelemetry/exporter-trace-otlp-proto|-http 0.301)", () => {
	test("选择逻辑：AGENTOBS_EXPORTER > OTEL_TRACES_EXPORTER > CLS 自动 > none；协议默认 http/protobuf", () => {
		assert.equal(resolveConfig({}, { OTEL_TRACES_EXPORTER: "otlp" }).exporter, "otlp");
		assert.equal(resolveConfig({}, { AGENTOBS_EXPORTER: "console", OTEL_TRACES_EXPORTER: "otlp" }).exporter, "console");
		assert.equal(resolveConfig({ exporter: "otlp" }, { AGENTOBS_EXPORTER: "cls" }).exporter, "otlp");
		assert.equal(resolveConfig({}, { OTEL_TRACES_EXPORTER: "jaeger" }).exporter, "none"); // 不认识的值忽略
		assert.deepEqual(resolveConfig({}, { OTEL_TRACES_EXPORTER: "otlp" }).missing, []);
		// 协议：options > TRACES_PROTOCOL > PROTOCOL > http/protobuf；grpc 降级 + 告警
		const proto = (o: object, e: NodeJS.ProcessEnv) => resolveConfig({ exporter: "otlp", ...o }, e);
		assert.equal(proto({}, {}).otlpProtocol, "http/protobuf");
		assert.equal(proto({}, { OTEL_EXPORTER_OTLP_PROTOCOL: "http/json" }).otlpProtocol, "http/json");
		assert.equal(proto({}, { OTEL_EXPORTER_OTLP_PROTOCOL: "http/json", OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/protobuf" }).otlpProtocol, "http/protobuf");
		assert.equal(proto({ otlpProtocol: "http/json" }, { OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/protobuf" }).otlpProtocol, "http/json");
		const g = proto({}, { OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" });
		assert.equal(g.otlpProtocol, "http/protobuf");
		assert.match(g.warnings.join(), /grpc unsupported/);
		assert.deepEqual(g.missing, []);
		// 非 otlp exporter 时不为协议告警
		assert.deepEqual(resolveConfig({ exporter: "console" }, { OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" }).warnings, []);
	});

	test("默认 http/protobuf：真实 session（503 重试 + 工具）→ /v1/traces，树/kind/status/resource/scope 正确", async () => {
		const col = await startCollector();
		const warns: string[] = [];
		const ext = createAgentObsExtension({
			exporter: "otlp",
			otlpEndpoint: `${col.base}/v1/traces`,
			otlpHeaders: { authorization: "Bearer test-token" },
			serviceName: "pi-otlp-e2e",
			resourceAttributes: { "deployment.environment": "test" },
			propagateTraceparent: true,
			logger: { info() {}, warn: (m) => warns.push(m) },
		});
		const h = await createHarness({ factories: [ext] });
		h.llm.script({ kind: "http_error", status: 503 }, { kind: "tools", calls: [{ id: "call_a", name: "read", args: { path: "a.txt" } }] }, { kind: "text", text: "done" });
		await h.session.prompt("read a.txt");
		await h.close(); // session_shutdown → forceFlush
		await waitFor(() => col.spans.length >= 9);
		await col.close();

		assert.deepEqual(warns, []);
		assert.deepEqual(col.errors, []);
		for (const r of col.requests) {
			assert.equal(r.url, "/v1/traces");
			assert.equal(r.headers["content-type"], "application/x-protobuf");
			assert.equal(r.headers.authorization, "Bearer test-token");
			assert.match(String(r.headers["user-agent"]), /agentobs-pi\/0\.1\.0/);
		}
		const spans = col.spans;
		// entry + agent + step×3(attempt1 失败轮, attempt2 的 round_2/round_3) + chat×3 + tool×1
		const byKind = (k: string) => spans.filter((s) => s.attributes["gen_ai.span.kind"] === k);
		assert.deepEqual(["entry", "agent", "step", "chat", "tool"].map((k) => byKind(k).length), [1, 1, 3, 3, 1]);
		assert.equal(new Set(spans.map((s) => s.traceId)).size, 1);
		assert.match(spans[0]!.traceId, /^[0-9a-f]{32}$/);
		const ids = new Set(spans.map((s) => s.spanId));
		const entry = byKind("entry")[0]!;
		assert.ok(!entry.parentSpanId, "entry is root");
		for (const s of spans) if (s !== entry) assert.ok(ids.has(s.parentSpanId!), `${s.name} orphan in OTLP`);

		assert.equal(entry.kind, KIND.SERVER);
		assert.equal(byKind("agent")[0]!.kind, KIND.INTERNAL);
		for (const c of byKind("chat")) assert.equal(c.kind, KIND.CLIENT);
		const failed = byKind("chat").filter((c) => c.status?.code === 2);
		assert.equal(failed.length, 1);
		assert.match(String(failed[0]!.status?.message), /^503/);
		assert.equal(failed[0]!.attributes["http.response.status_code"], 503);
		assert.ok(byKind("chat").filter((c) => c !== failed[0]).every((c) => !c.status?.code), "成功 span 保持 UNSET");

		// 时间：纳秒、end >= start
		for (const s of spans) assert.ok(BigInt(s.endTimeUnixNano) >= BigInt(s.startTimeUnixNano) && BigInt(s.startTimeUnixNano) > 1_700_000_000_000_000_000n);
		// resource / scope
		assert.equal(entry.resource["service.name"], "pi-otlp-e2e");
		assert.equal(entry.resource["deployment.environment"], "test");
		assert.equal(entry.resource["telemetry.sdk.name"], "tencentcloud-agentobs-sdk-pi");
		assert.deepEqual(entry.scope, { name: "tencentcloud-agentobs-sdk-pi", version: "0.1.0" });
		// 属性类型保真（数字仍是数字）+ 内容属性
		const agent = byKind("agent")[0]!;
		assert.equal(agent.attributes["pi.agent.attempts"], 2);
		assert.equal(agent.attributes["gen_ai.usage.input_tokens"], 200);
		assert.ok(agent.attributes["gen_ai.agent.id"]);
		assert.match(String(byKind("tool")[0]!.attributes["gen_ai.tool.call.result"]), /hello from a/);
		// traceparent 与 OTLP 中的 chat span 对得上（LLM 网关链路可串联）
		const expected = new Set(byKind("chat").map((c) => `00-${c.traceId}-${c.spanId}-01`));
		for (const r of h.llm.requests) assert.ok(expected.has(String(r.headers.traceparent)));
	});

	test("纯环境变量（文件扩展 = pi install 路径）：OTEL_EXPORTER_OTLP_ENDPOINT 自动拼 /v1/traces，读 HEADERS，gzip", async () => {
		const col = await startCollector();
		const ENV = {
			OTEL_TRACES_EXPORTER: "otlp",
			OTEL_EXPORTER_OTLP_ENDPOINT: col.base,
			OTEL_EXPORTER_OTLP_HEADERS: "x-api-key=k123,x-tenant=pi",
			OTEL_EXPORTER_OTLP_COMPRESSION: "gzip",
			OTEL_SERVICE_NAME: "pi-from-env",
		};
		Object.assign(process.env, ENV);
		try {
			const h = await createHarness({ extensionPaths: [EXT_PATH] });
			h.llm.script({ kind: "text", text: "hi" });
			await h.session.prompt("hi");
			await h.close();
			await waitFor(() => col.spans.length >= 4);
		} finally {
			for (const k of Object.keys(ENV)) delete process.env[k];
			await col.close();
		}
		assert.equal(col.spans.length, 4);
		assert.deepEqual(col.errors, []);
		const r = col.requests[0]!;
		assert.equal(r.url, "/v1/traces");
		assert.equal(r.headers["content-type"], "application/x-protobuf");
		assert.equal(r.headers["x-api-key"], "k123");
		assert.equal(r.headers["x-tenant"], "pi");
		assert.equal(r.headers["content-encoding"], "gzip");
		assert.equal(col.spans[0]!.resource["service.name"], "pi-from-env");
	});

	test("otlpProtocol=http/json：走 -otlp-http，application/json，hex id，同一棵树", async () => {
		const col = await startCollector();
		const warns: string[] = [];
		const ext = createAgentObsExtension({
			exporter: "otlp",
			otlpProtocol: "http/json",
			otlpEndpoint: `${col.base}/v1/traces`,
			logger: { info() {}, warn: (m) => warns.push(m) },
		});
		const h = await createHarness({ factories: [ext] });
		h.llm.script({ kind: "text", text: "hi" });
		await h.session.prompt("hi");
		await h.close();
		await waitFor(() => col.spans.length >= 4);
		await col.close();
		assert.deepEqual(warns, []);
		assert.deepEqual(col.errors, []);
		assert.equal(col.requests[0]!.headers["content-type"], "application/json");
		assert.equal(col.spans.length, 4);
		assert.match(col.spans[0]!.traceId, /^[0-9a-f]{32}$/);
		const ids = new Set(col.spans.map((s) => s.spanId));
		const roots = col.spans.filter((s) => !s.parentSpanId);
		assert.equal(roots.length, 1);
		for (const s of col.spans) if (s !== roots[0]) assert.ok(ids.has(s.parentSpanId!));
	});

	test("OTEL_EXPORTER_OTLP_PROTOCOL=grpc：启动告警一次并降级为 http/protobuf，数据照常送达", async () => {
		const col = await startCollector();
		const warns: string[] = [];
		process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "grpc";
		try {
			const ext = createAgentObsExtension({
				exporter: "otlp",
				otlpEndpoint: `${col.base}/v1/traces`,
				logger: { info() {}, warn: (m) => warns.push(m) },
			});
			const h = await createHarness({ factories: [ext] });
			h.llm.script({ kind: "text", text: "hi" });
			await h.session.prompt("hi");
			await h.close();
			await waitFor(() => col.spans.length >= 4);
		} finally {
			delete process.env.OTEL_EXPORTER_OTLP_PROTOCOL;
			await col.close();
		}
		assert.equal(warns.length, 1);
		assert.match(warns[0]!, /OTEL_EXPORTER_OTLP_PROTOCOL=grpc unsupported .* falling back to http\/protobuf/);
		assert.equal(col.requests[0]!.headers["content-type"], "application/x-protobuf");
		assert.equal(col.spans.length, 4);
	});

	test("Collector 返回 400：只告警，agent 正常完成", async () => {
		const col = await startCollector(400);
		const warns: string[] = [];
		const ext = createAgentObsExtension({
			exporter: "otlp",
			otlpEndpoint: `${col.base}/v1/traces`,
			logger: { info() {}, warn: (m) => warns.push(m) },
		});
		const h = await createHarness({ factories: [ext] });
		h.llm.script({ kind: "text", text: "fine" });
		await h.session.prompt("hi");
		const last = h.session.messages.at(-1) as any;
		assert.equal(last?.stopReason, "stop");
		await h.close();
		await waitFor(() => warns.length > 0);
		await col.close();
		assert.ok(col.requests.length >= 1);
		assert.match(warns.join("\n"), /otlp export failed, 4 spans lost/);
	});
});
