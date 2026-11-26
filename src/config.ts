/**
 * 配置解析。环境变量与 tencentcloud-agentobs-sdk-dsh 对齐（CLS_*、OTEL_*），
 * 另加少量 AGENTOBS_* 开关用于本地调试。显式 options 优先于环境变量。
 */

export type ExporterKind = "cls" | "otlp" | "console" | "none";
const EXPORTER_KINDS = new Set<ExporterKind>(["cls", "otlp", "console", "none"]);
/** OTLP 传输协议（OTel 规范取值）；grpc 暂不支持 */
export type OtlpProtocol = "http/protobuf" | "http/json";

export interface AgentObsOptions {
	enabled?: boolean;
	/** cls：直传 CLS；otlp：OTLP/HTTP 发往 Collector/后端；console：每个 span 一行 JSON（stderr 或文件）；none：只在内存里组装不输出 */
	exporter?: ExporterKind;
	/**
	 * OTLP 编码。默认 http/protobuf（OTel 规范默认值）；不传时读
	 * OTEL_EXPORTER_OTLP_TRACES_PROTOCOL / OTEL_EXPORTER_OTLP_PROTOCOL
	 */
	otlpProtocol?: OtlpProtocol;
	/**
	 * OTLP traces 完整地址（含 /v1/traces）。不传时由官方 exporter 按 OTel 规范读取
	 * OTEL_EXPORTER_OTLP_TRACES_ENDPOINT / OTEL_EXPORTER_OTLP_ENDPOINT(+/v1/traces)，默认 http://localhost:4318/v1/traces
	 */
	otlpEndpoint?: string;
	/** OTLP 请求头；不传时读取 OTEL_EXPORTER_OTLP_TRACES_HEADERS / OTEL_EXPORTER_OTLP_HEADERS */
	otlpHeaders?: Record<string, string>;
	/** 单次导出超时；不传时读取 OTEL_EXPORTER_OTLP_TIMEOUT，默认 10000 */
	otlpTimeoutMs?: number;
	/** gzip / none；不传时读取 OTEL_EXPORTER_OTLP_COMPRESSION */
	otlpCompression?: "gzip" | "none";
	endpoint?: string;
	topicId?: string;
	secretId?: string;
	secretKey?: string;
	uin?: string;
	serviceName?: string;
	resourceAttributes?: Record<string, string>;
	captureContent?: boolean;
	contentMaxChars?: number;
	/** 向 LLM 请求注入 W3C traceparent（chat span），便于串联自建 LLM 网关链路 */
	propagateTraceparent?: boolean;
	consoleFile?: string;
	batchMaxSize?: number;
	maxBatchBytes?: number;
	maxQueueSize?: number;
	flushIntervalMs?: number;
	retryTimes?: number;
	debug?: boolean;
}

export interface ResolvedConfig {
	enabled: boolean;
	exporter: ExporterKind;
	otlpProtocol: OtlpProtocol;
	/** 仅显式传入的 OTLP 选项；undefined 表示交给官方 exporter 读 OTEL_EXPORTER_OTLP_* 环境变量 */
	otlpEndpoint?: string;
	otlpHeaders?: Record<string, string>;
	otlpTimeoutMs?: number;
	otlpCompression?: "gzip" | "none";
	endpoint: string;
	topicId: string;
	secretId: string;
	secretKey: string;
	uin: string;
	serviceName: string;
	resourceAttributes: Record<string, string>;
	captureContent: boolean;
	contentMaxChars: number;
	propagateTraceparent: boolean;
	consoleFile: string;
	batchMaxSize: number;
	maxBatchBytes: number;
	maxQueueSize: number;
	flushIntervalMs: number;
	retryTimes: number;
	debug: boolean;
	/** exporter=cls 但配置不全时列出缺失项，此时自动降级为 none */
	missing: string[];
	/** 非致命配置问题（如不支持的 OTLP 协议已降级），启动时告警一次 */
	warnings: string[];
}

const FALSY = new Set(["FALSE", "NO", "OFF", "DISABLED", "0"]);
const TRUTHY = new Set(["TRUE", "YES", "ON", "ENABLED", "1"]);

function envBool(env: NodeJS.ProcessEnv, key: string): boolean | undefined {
	const raw = env[key]?.trim().toUpperCase();
	if (raw === undefined || raw === "") return undefined;
	if (TRUTHY.has(raw)) return true;
	if (FALSY.has(raw)) return false;
	return undefined;
}

function envInt(env: NodeJS.ProcessEnv, key: string): number | undefined {
	const raw = env[key];
	if (!raw) return undefined;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function parseResourceAttributes(raw: string | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	if (!raw) return out;
	for (const pair of raw.split(",")) {
		const i = pair.indexOf("=");
		if (i <= 0) continue;
		const k = pair.slice(0, i).trim();
		if (k) out[k] = pair.slice(i + 1).trim();
	}
	return out;
}

/**
 * 规范化 CLS 接入点，保证默认走 HTTPS。
 * tencentcloud-cls-sdk-js@1.1.1 AsyncClient 构造函数（dist/asyncClient.js L73-84）对不带 scheme 的
 * endpoint 默认使用 http://，因此这里不能剥掉 scheme（dsh 版 cls-flusher.js L37 剥掉后会明文上报）。
 * 仅当用户显式写 http:// 时才保留明文（本地联调 / 内网代理）。
 */
export function normalizeEndpoint(raw: string): string {
	const v = raw.trim().replace(/\/+$/, "");
	if (v === "") return "";
	if (/^https?:\/\//i.test(v)) return v.replace(/^(https?):\/\//i, (_m, p: string) => `${p.toLowerCase()}://`);
	return `https://${v}`;
}

/**
 * 协议：显式选项 > OTEL_EXPORTER_OTLP_TRACES_PROTOCOL > OTEL_EXPORTER_OTLP_PROTOCOL > http/protobuf。
 * grpc 不支持（需要 @grpc/grpc-js 且端口语义不同），遇到时记入 warnings 并降级到 http/protobuf，
 * 由扩展启动时告警，避免“以为在发 gRPC，实际 4317 端口收到 HTTP 请求”这种静默失败。
 */
function resolveOtlpProtocol(opt: OtlpProtocol | undefined, env: NodeJS.ProcessEnv, warnings: string[], exporter: ExporterKind): OtlpProtocol {
	const raw = (opt ?? env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL ?? env.OTEL_EXPORTER_OTLP_PROTOCOL ?? "").trim().toLowerCase();
	if (raw === "http/json") return "http/json";
	if (raw === "" || raw === "http/protobuf") return "http/protobuf";
	if (exporter === "otlp") warnings.push(`OTEL_EXPORTER_OTLP_PROTOCOL=${raw} unsupported (use http/protobuf or http/json), falling back to http/protobuf`);
	return "http/protobuf";
}

export function resolveConfig(opts: AgentObsOptions = {}, env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
	const endpoint = normalizeEndpoint(opts.endpoint ?? env.CLS_ENDPOINT ?? "");
	const topicId = opts.topicId ?? env.CLS_TOPIC_ID ?? "";
	const secretId = opts.secretId ?? env.CLS_SECRET_ID ?? "";
	const secretKey = opts.secretKey ?? env.CLS_SECRET_KEY ?? "";
	const uin = opts.uin ?? env.CLS_UIN ?? "";
	const hasStrong = secretId !== "" && secretKey !== "";
	const hasWeak = uin !== "" && /^\d+$/.test(uin);
	const clsComplete = endpoint !== "" && topicId !== "" && (hasStrong || hasWeak);

	// 选择顺序：显式 options > AGENTOBS_EXPORTER > OTEL_TRACES_EXPORTER（OTel 标准变量）> CLS 配置齐全则 cls > none
	const pick = (raw: string | undefined): ExporterKind | undefined => {
		const v = raw?.split(",")[0]?.trim().toLowerCase() as ExporterKind | undefined;
		return v && EXPORTER_KINDS.has(v) ? v : undefined;
	};
	let exporter: ExporterKind =
		opts.exporter ?? pick(env.AGENTOBS_EXPORTER) ?? pick(env.OTEL_TRACES_EXPORTER) ?? (clsComplete ? "cls" : "none");

	const missing: string[] = [];
	if (exporter === "cls" && !clsComplete) {
		if (!endpoint) missing.push("CLS_ENDPOINT");
		if (!topicId) missing.push("CLS_TOPIC_ID");
		if (!hasStrong && !hasWeak) missing.push(uin ? "CLS_UIN (must be digits only)" : "CLS_SECRET_ID + CLS_SECRET_KEY (or CLS_UIN)");
		exporter = "none";
	}
	const warnings: string[] = [];

	// 内容采集默认开启（与 dsh 版一致），可用 OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=false 关闭
	const captureEnv = envBool(env, "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT");

	return {
		enabled: opts.enabled ?? envBool(env, "AGENTOBS_ENABLED") ?? true,
		exporter,
		otlpProtocol: resolveOtlpProtocol(opts.otlpProtocol, env, warnings, exporter),
		otlpEndpoint: opts.otlpEndpoint,
		otlpHeaders: opts.otlpHeaders,
		otlpTimeoutMs: opts.otlpTimeoutMs,
		otlpCompression: opts.otlpCompression,
		endpoint,
		topicId,
		secretId,
		secretKey,
		uin,
		serviceName: opts.serviceName ?? env.CLS_SERVICE_NAME ?? env.OTEL_SERVICE_NAME ?? "pi-coding-agent",
		resourceAttributes: { ...parseResourceAttributes(env.OTEL_RESOURCE_ATTRIBUTES), ...(opts.resourceAttributes ?? {}) },
		captureContent: opts.captureContent ?? captureEnv ?? true,
		contentMaxChars: opts.contentMaxChars ?? envInt(env, "AGENTOBS_CONTENT_MAX_CHARS") ?? 128_000,
		propagateTraceparent: opts.propagateTraceparent ?? envBool(env, "AGENTOBS_PROPAGATE_TRACEPARENT") ?? false,
		consoleFile: opts.consoleFile ?? env.AGENTOBS_CONSOLE_FILE ?? "",
		batchMaxSize: opts.batchMaxSize ?? 32,
		maxBatchBytes: opts.maxBatchBytes ?? 10 * 1024 * 1024,
		maxQueueSize: opts.maxQueueSize ?? 2048,
		flushIntervalMs: opts.flushIntervalMs ?? 5_000,
		retryTimes: opts.retryTimes ?? 3,
		debug: opts.debug ?? envBool(env, "AGENTOBS_DEBUG") ?? false,
		missing,
		warnings,
	};
}
