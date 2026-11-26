// 模型接入点连通性探测：只发一个最小的 chat 请求，确认 baseUrl / 模型 id / API key 可用，
// 并检查是否支持 tool calling（真实模型用例需要模型主动调用 read 工具）。
// 用法：REAL_LLM_BASE_URL=... REAL_LLM_MODEL=... REAL_LLM_API_KEY=... npm run probe:llm
const baseUrl = process.env.REAL_LLM_BASE_URL?.trim();
const model = process.env.REAL_LLM_MODEL?.trim();
const apiKey = process.env.REAL_LLM_API_KEY?.trim();
if (!baseUrl || !model || !apiKey) {
	console.error("需要 REAL_LLM_BASE_URL / REAL_LLM_MODEL / REAL_LLM_API_KEY");
	process.exit(2);
}
const u = new URL(baseUrl);
const local = u.hostname === "127.0.0.1" || u.hostname === "localhost";
if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) {
	console.error("REAL_LLM_BASE_URL 必须是 https://（localhost 可用 http）");
	process.exit(2);
}
const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
console.log(`→ POST ${url}  model=${model}  key=${apiKey.slice(0, 4)}…${apiKey.slice(-4)}`);

/** OpenAI Chat Completions 响应中本脚本实际读取的字段 */
interface ChatCompletion {
	model?: string;
	usage?: Record<string, number>;
	choices?: Array<{ message?: { content?: string; tool_calls?: unknown } }>;
	sse?: boolean;
}

function errLabel(e: unknown): string {
	if (e instanceof Error) {
		const code = (e.cause as { code?: string } | undefined)?.code;
		return `${code ?? e.name} ${e.message}`;
	}
	return String(e);
}

async function post(body: unknown, label: string, expectSse = false): Promise<ChatCompletion | undefined> {
	const t0 = Date.now();
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
			body: JSON.stringify(body),
			redirect: "error",
			signal: AbortSignal.timeout(60_000),
		});
		const text = await res.text();
		const ms = Date.now() - t0;
		if (!res.ok) {
			console.log(`✖ ${label}: HTTP ${res.status} (${ms}ms)  ${text.slice(0, 300)}`);
			return undefined;
		}
		if (expectSse) {
			// pi 走流式：返回体应是 SSE（data: {...} 行），末尾 [DONE]
			const ok = text.includes("data:");
			console.log(`${ok ? "✔" : "✖"} ${label}: HTTP 200 (${ms}ms)  ${ok ? `SSE ${text.split("data:").length - 1} 个 chunk` : `非 SSE：${text.slice(0, 160)}`}`);
			return ok ? { sse: true } : undefined;
		}
		let json: ChatCompletion;
		try {
			json = JSON.parse(text) as ChatCompletion;
		} catch {
			console.log(`✖ ${label}: 返回非 JSON (${ms}ms)  ${text.slice(0, 200)}`);
			return undefined;
		}
		console.log(`✔ ${label}: HTTP 200 (${ms}ms)  model=${json.model ?? "?"}  usage=${JSON.stringify(json.usage ?? {})}`);
		return json;
	} catch (e: unknown) {
		console.log(`✖ ${label}: ${errLabel(e)}`);
		return undefined;
	}
}

const chat = await post({ model, messages: [{ role: "user", content: "reply with the single word: ok" }], max_tokens: 16, stream: false }, "基础 chat");
if (chat) {
	const content = chat.choices?.[0]?.message?.content ?? "";
	console.log(`  回复: ${String(content).slice(0, 80)}`);
}

const tools = await post(
	{
		model,
		messages: [{ role: "user", content: "Read the file a.txt using the read tool." }],
		tools: [{ type: "function", function: { name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }],
		max_tokens: 128,
		stream: false,
	},
	"tool calling",
);
if (tools) {
	const tc = tools.choices?.[0]?.message?.tool_calls;
	console.log(`  tool_calls: ${tc ? JSON.stringify(tc).slice(0, 200) : "（模型未调用工具，真实用例的 tool span 可能为 0）"}`);
}

const streamed = await post({ model, messages: [{ role: "user", content: "say ok" }], max_tokens: 16, stream: true }, "stream 模式（pi 使用）", true);
if (!streamed) console.log("  注意：pi 只走流式，该项失败则无法用于验证");

console.log(`\n三项均为 ✔ 时即可运行：\n  REAL_LLM_BASE_URL=${baseUrl} REAL_LLM_MODEL=${model} REAL_LLM_API_KEY=$MAAS_API_KEY npm run verify:real`);
