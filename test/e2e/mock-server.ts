// OpenAI Chat Completions 兼容的 mock 服务：按脚本队列逐次返回 SSE 流或 HTTP 错误。
import http from "node:http";
import type { AddressInfo } from "node:net";

export type ToolCallSpec = { id: string; name: string; args: Record<string, unknown> };
export type Step =
	| { kind: "text"; text: string; usage?: [number, number] }
	| { kind: "tools"; calls: ToolCallSpec[]; usage?: [number, number] }
	| { kind: "http_error"; status: number; body?: string };

export interface RecordedRequest {
	headers: http.IncomingHttpHeaders;
	body: any;
}

export class MockLLM {
	private queue: Step[] = [];
	readonly requests: RecordedRequest[] = [];
	private server = http.createServer((req, res) => this.handle(req, res));
	url = "";

	async start(): Promise<void> {
		await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", () => r()));
		this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1`;
	}
	stop(): Promise<void> {
		return new Promise((r) => this.server.close(() => r()));
	}
	script(...steps: Step[]): void {
		this.queue.push(...steps);
	}
	get pending(): number {
		return this.queue.length;
	}
	clear(): void {
		this.queue.length = 0;
	}

	private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
		let raw = "";
		req.on("data", (c) => (raw += c));
		req.on("end", () => {
			let body: any = undefined;
			try {
				body = JSON.parse(raw);
			} catch {}
			this.requests.push({ headers: req.headers, body });
			const step = this.queue.shift() ?? { kind: "text", text: "(queue empty)" };
			if (step.kind === "http_error") {
				res.writeHead(step.status, { "content-type": "application/json", "x-request-id": `err-${this.requests.length}` });
				res.end(step.body ?? JSON.stringify({ error: { message: "mock upstream overloaded", type: "server_error" } }));
				return;
			}
			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				"x-request-id": `req-${this.requests.length}`,
			});
			const id = `chatcmpl-${this.requests.length}`;
			const model = "mock-gpt-2026-11-01";
			const chunk = (delta: any, finish: string | null = null) =>
				`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
			const [pin, pout] = step.usage ?? [100, 20];
			const usage = `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model, choices: [], usage: { prompt_tokens: pin, completion_tokens: pout, total_tokens: pin + pout, prompt_tokens_details: { cached_tokens: 40 } } })}\n\n`;
			const parts: string[] = [chunk({ role: "assistant", content: "" })];
			if (step.kind === "text") {
				for (const w of step.text.split(/(?<= )/)) parts.push(chunk({ content: w }));
				parts.push(chunk({}, "stop"));
			} else {
				step.calls.forEach((c, i) => {
					parts.push(chunk({ tool_calls: [{ index: i, id: c.id, type: "function", function: { name: c.name, arguments: "" } }] }));
					parts.push(chunk({ tool_calls: [{ index: i, function: { arguments: JSON.stringify(c.args) } }] }));
				});
				parts.push(chunk({}, "tool_calls"));
			}
			parts.push(usage, "data: [DONE]\n\n");
			let i = 0;
			const tick = () => {
				if (i >= parts.length) return res.end();
				res.write(parts[i++]);
				setTimeout(tick, 5);
			};
			tick();
		});
	}
}
