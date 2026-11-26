// 把 CLS span（JSON 行）还原成调用树打印，便于肉眼核对层级
import type { CLSSpan } from "../../src/span.ts";

const KEY_ATTRS = [
	"gen_ai.request.model",
	"gen_ai.response.model",
	"gen_ai.response.finish_reasons",
	"gen_ai.usage.input_tokens",
	"gen_ai.usage.output_tokens",
	"gen_ai.usage.cache_read.input_tokens",
	"gen_ai.response.time_to_first_token_ms",
	"http.response.status_code",
	"pi.provider.request_id",
	"pi.request.prepare_ms",
	"pi.agent.attempt",
	"pi.agent.attempts",
	"pi.agent.retries",
	"pi.turn_index",
	"gen_ai.tool.call.id",
	"error.type",
];

export function renderTrees(spans: CLSSpan[], opts: { attrs?: boolean } = {}): string {
	const out: string[] = [];
	const byTrace = new Map<string, CLSSpan[]>();
	for (const s of spans) {
		if (!byTrace.has(s.traceID)) byTrace.set(s.traceID, []);
		byTrace.get(s.traceID)!.push(s);
	}
	for (const [traceId, list] of byTrace) {
		const ids = new Set(list.map((s) => s.spanID));
		const children = new Map<string, CLSSpan[]>();
		for (const s of list) {
			const p = ids.has(s.parentSpanID) ? s.parentSpanID : "";
			if (!children.has(p)) children.set(p, []);
			children.get(p)!.push(s);
		}
		for (const c of children.values()) c.sort((a, b) => (BigInt(a.start) < BigInt(b.start) ? -1 : 1));
		out.push(`trace ${traceId}  (${list.length} spans)`);
		const walk = (parent: string, depth: number) => {
			for (const s of children.get(parent) ?? []) {
				const status = s.statusCode === "ERROR" ? `  ❌ ${s.statusMessage.slice(0, 80)}` : "";
				out.push(`${"  ".repeat(depth + 1)}${s.name} [${s.spanKind}/${s.kind}] ${s.durationMs}ms${status}`);
				if (opts.attrs !== false) {
					const kv = KEY_ATTRS.filter((k) => s.attribute[k] !== undefined).map((k) => `${k.replace(/^gen_ai\./, "")}=${s.attribute[k]}`);
					if (kv.length) out.push(`${"  ".repeat(depth + 2)}· ${kv.join("  ")}`);
				}
				walk(s.spanID, depth + 1);
			}
		};
		walk("", 0);
	}
	return out.join("\n");
}
