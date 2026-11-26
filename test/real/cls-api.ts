// CLS 云 API 3.0 最小客户端（TC3-HMAC-SHA256 签名），只用于真实环境回查：SearchLog / DescribeIndex。
// 参考：https://cloud.tencent.com/document/api/614/56474（SearchLog）
import { createHash, createHmac } from "node:crypto";

const VERSION = "2020-10-16";
const SERVICE = "cls";

export interface ClsApiOptions {
	secretId: string;
	secretKey: string;
	/** 临时密钥需要 */
	token?: string;
	region: string;
	/** 云 API 域名，仅允许 *.tencentcloudapi.com */
	host?: string;
}

export interface SearchResult {
	Results?: Array<{ Time: number; LogJson: string }>;
	ListOver?: boolean;
	Context?: string;
}

export class ClsApiError extends Error {
	code: string;
	requestId: string;
	constructor(code: string, message: string, requestId: string) {
		super(`${code}: ${message} (RequestId=${requestId})`);
		this.code = code;
		this.requestId = requestId;
	}
}

const sha256Hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const hmac = (key: Buffer | string, s: string) => createHmac("sha256", key).update(s, "utf8").digest();

/** 从 CLS 上报域名推导地域：ap-guangzhou.cls.tencentcs.com / ap-guangzhou.cls.tencentyun.com → ap-guangzhou */
export function regionFromEndpoint(endpoint: string): string | undefined {
	const host = endpoint.replace(/^https?:\/\//i, "").split(/[/:]/)[0] ?? "";
	const m = /^([a-z]+(?:-[a-z]+)+(?:-\d+)?)\.cls\./i.exec(host);
	return m?.[1]?.toLowerCase();
}

export function validateApiHost(host: string): string {
	const h = host.trim().toLowerCase();
	if (!/^[a-z0-9.-]+\.tencentcloudapi\.com$/.test(h)) throw new Error(`CLS_API_HOST must be a *.tencentcloudapi.com host, got: ${host}`);
	return h;
}

export class ClsApi {
	private readonly opts: Required<Omit<ClsApiOptions, "token">> & { token?: string };

	constructor(opts: ClsApiOptions) {
		if (!opts.secretId || !opts.secretKey) throw new Error("CLS API requires secretId/secretKey");
		if (!/^[a-z]+(?:-[a-z]+)+(?:-\d+)?$/.test(opts.region)) throw new Error(`invalid region: ${opts.region}`);
		this.opts = { ...opts, host: validateApiHost(opts.host ?? "cls.tencentcloudapi.com") };
	}

	async call<T>(action: string, payload: Record<string, unknown>): Promise<T> {
		const { host, region, secretId, secretKey, token } = this.opts;
		if (!/^[A-Za-z]+$/.test(action)) throw new Error(`invalid action: ${action}`);
		const body = JSON.stringify(payload);
		const ts = Math.floor(Date.now() / 1000);
		const date = new Date(ts * 1000).toISOString().slice(0, 10);
		const contentType = "application/json; charset=utf-8";
		const canonical = ["POST", "/", "", `content-type:${contentType}`, `host:${host}`, "", "content-type;host", sha256Hex(body)].join("\n");
		const scope = `${date}/${SERVICE}/tc3_request`;
		const toSign = ["TC3-HMAC-SHA256", String(ts), scope, sha256Hex(canonical)].join("\n");
		const kSigning = hmac(hmac(hmac(`TC3${secretKey}`, date), SERVICE), "tc3_request");
		const signature = createHmac("sha256", kSigning).update(toSign, "utf8").digest("hex");
		const headers: Record<string, string> = {
			authorization: `TC3-HMAC-SHA256 Credential=${secretId}/${scope}, SignedHeaders=content-type;host, Signature=${signature}`,
			"content-type": contentType,
			host,
			"x-tc-action": action,
			"x-tc-timestamp": String(ts),
			"x-tc-version": VERSION,
			"x-tc-region": region,
		};
		if (token) headers["x-tc-token"] = token;
		const res = await fetch(`https://${host}/`, { method: "POST", headers, body, redirect: "error", signal: AbortSignal.timeout(15_000) });
		const json = (await res.json()) as { Response?: { Error?: { Code: string; Message: string }; RequestId?: string } & T };
		const r = json.Response;
		if (!r) throw new ClsApiError("InvalidResponse", `HTTP ${res.status}`, "");
		if (r.Error) throw new ClsApiError(r.Error.Code, r.Error.Message, r.RequestId ?? "");
		return r as T;
	}

	/** CQL 检索（SyntaxRule=1），返回每条日志的字段 map */
	async search(topicId: string, query: string, fromMs: number, toMs: number, limit = 1000): Promise<Array<Record<string, string>>> {
		const out: Array<Record<string, string>> = [];
		let context: string | undefined;
		for (let page = 0; page < 10; page++) {
			const r = await this.call<SearchResult>("SearchLog", {
				TopicId: topicId,
				From: fromMs,
				To: toMs,
				Query: query,
				Limit: limit,
				Sort: "asc",
				SyntaxRule: 1,
				...(context ? { Context: context } : {}),
			});
			for (const item of r.Results ?? []) {
				try {
					out.push(JSON.parse(item.LogJson) as Record<string, string>);
				} catch {
					// 非 JSON 日志忽略
				}
			}
			if (r.ListOver !== false || !r.Context) break;
			context = r.Context;
		}
		return out;
	}

	async describeIndex(topicId: string): Promise<{ Status?: boolean; Rule?: { FullText?: unknown; KeyValue?: { KeyValues?: Array<{ Key: string }> } } }> {
		return this.call("DescribeIndex", { TopicId: topicId });
	}
}
