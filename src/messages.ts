/**
 * Pi 消息 → GenAI semconv 消息结构（gen_ai.input.messages / gen_ai.output.messages）。
 * 结构与 dsh 版一致：{ role, parts: [{type, content | id/name/arguments | response}], finish_reason? }
 */

type Part = Record<string, unknown>;
export interface GenAIMessage {
	role: string;
	parts: Part[];
	finish_reason?: string;
}

function mapBlock(block: any): Part | undefined {
	if (block == null) return undefined;
	if (typeof block === "string") return { type: "text", content: block };
	switch (block.type) {
		case "text":
			return { type: "text", content: block.text ?? "" };
		case "thinking":
			return block.redacted ? { type: "reasoning", content: "[redacted]" } : { type: "reasoning", content: block.thinking ?? "" };
		case "toolCall":
			return { type: "tool_call", id: block.id ?? null, name: block.name ?? "", arguments: block.arguments ?? {} };
		case "image":
			// 不上传 base64 图片，只保留元信息
			return { type: "image", mime_type: block.mimeType, bytes: typeof block.data === "string" ? Math.floor((block.data.length * 3) / 4) : undefined };
		default:
			return { type: String(block.type ?? "unknown") };
	}
}

export function mapContent(content: unknown): Part[] {
	if (typeof content === "string") return [{ type: "text", content }];
	if (!Array.isArray(content)) return [];
	return content.map(mapBlock).filter((p): p is Part => p !== undefined);
}

/** Pi stopReason → GenAI finish_reason */
export function mapFinishReason(stop: string | undefined): string {
	switch (stop) {
		case "stop":
			return "stop";
		case "length":
			return "length";
		case "toolUse":
			return "tool_calls";
		case "error":
			return "error";
		case "aborted":
			return "aborted";
		case undefined:
			return "unknown";
		default:
			return stop;
	}
}

/**
 * Pi AgentMessage → GenAI 消息；只保留会进入 LLM 的三类角色。
 * Pi 还有 system/custom/bashExecution 等宿主侧消息，按 convertToLlm 规则并不总是发给模型，这里不计入。
 */
export function mapAgentMessage(msg: any): GenAIMessage | undefined {
	switch (msg?.role) {
		case "user":
			return { role: "user", parts: mapContent(msg.content) };
		case "assistant":
			return { role: "assistant", parts: mapContent(msg.content), finish_reason: mapFinishReason(msg.stopReason) };
		case "toolResult":
			return {
				role: "tool",
				parts: [{ type: "tool_call_response", id: msg.toolCallId ?? null, response: mapContent(msg.content) }],
			};
		default:
			return undefined;
	}
}

export function mapToolResult(result: any): unknown {
	if (result && typeof result === "object" && "content" in result) return mapContent(result.content);
	return result;
}
