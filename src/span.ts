/**
 * CLS span model — 与 tencentcloud-agentobs-sdk-dsh 保持一致的 5 层模型：
 *   entry → agent → step → chat / tool
 * 每个 span 在 CLS 中是一条日志，attribute 序列化为 JSON 字符串字段。
 */
import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";

export type SpanKindName = "entry" | "agent" | "step" | "chat" | "tool";
export type AttrValue = string | number | boolean;

export interface CLSSpan {
	spanKind: SpanKindName;
	traceID: string;
	spanID: string;
	parentSpanID: string;
	sessionID: string;
	agentID: string;
	parentAgentID: string;
	stepID: string;
	name: string;
	kind: "INTERNAL" | "SERVER" | "CLIENT";
	statusCode: "UNSET" | "OK" | "ERROR";
	statusMessage: string;
	/** 纳秒时间戳字符串 */
	start: string;
	end: string;
	duration: string;
	durationMs: string;
	host: string;
	service: string;
	links: string;
	attribute: Record<string, AttrValue>;
}

export function newTraceId(): string {
	return randomBytes(16).toString("hex");
}

export function newSpanId(): string {
	return randomBytes(8).toString("hex");
}

export function msToNanoStr(ms: number): string {
	return String(BigInt(Math.max(0, Math.round(ms))) * 1_000_000n);
}

export function durationMs(startMs: number, endMs: number): number {
	return Math.max(0, Math.round(endMs - startMs));
}

export function safeStringify(value: unknown): string {
	try {
		const seen = new WeakSet<object>();
		return JSON.stringify(value, (_k, v) => {
			if (typeof v === "bigint") return v.toString();
			if (v !== null && typeof v === "object") {
				if (seen.has(v)) return "[Circular]";
				seen.add(v);
			}
			return v;
		}) ?? "";
	} catch {
		return String(value);
	}
}

export function truncate(value: string, maxChars: number): string {
	return value.length <= maxChars ? value : `${value.slice(0, maxChars)}...[truncated]`;
}

/** CLS SDK 需要非空 sourceIp；取首个非内网回环 IPv4，退化为 127.0.0.1。 */
export function getLocalIp(): string {
	for (const list of Object.values(networkInterfaces())) {
		for (const addr of list ?? []) {
			if (addr.family === "IPv4" && !addr.internal) return addr.address;
		}
	}
	return "127.0.0.1";
}

export function buildSpan(init: {
	spanKind: SpanKindName;
	traceID: string;
	spanID: string;
	parentSpanID?: string;
	sessionID: string;
	agentID?: string;
	stepID?: string;
	name: string;
	kind: CLSSpan["kind"];
	error?: string | undefined;
	startMs: number;
	endMs: number;
	host: string;
	service: string;
	attribute: Record<string, AttrValue | undefined>;
}): CLSSpan {
	const attribute: Record<string, AttrValue> = {};
	for (const [k, v] of Object.entries(init.attribute)) {
		if (v !== undefined && v !== "") attribute[k] = v;
	}
	const endMs = Math.max(init.startMs, init.endMs);
	return {
		spanKind: init.spanKind,
		traceID: init.traceID,
		spanID: init.spanID,
		parentSpanID: init.parentSpanID ?? "",
		sessionID: init.sessionID,
		agentID: init.agentID ?? "",
		parentAgentID: "",
		stepID: init.stepID ?? "",
		name: init.name,
		kind: init.kind,
		statusCode: init.error !== undefined ? "ERROR" : "OK",
		statusMessage: init.error ?? "",
		start: msToNanoStr(init.startMs),
		end: msToNanoStr(endMs),
		duration: String(BigInt(durationMs(init.startMs, endMs)) * 1_000_000n),
		durationMs: String(durationMs(init.startMs, endMs)),
		host: init.host,
		service: init.service,
		links: "[]",
		attribute,
	};
}
