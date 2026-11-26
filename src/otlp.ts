/**
 * OTLP 导出器：CLSSpan → OTel ReadableSpan → 官方 BatchSpanProcessor + OTLPTraceExporter
 * （默认 OTLP/HTTP protobuf，可选 http/json）。
 *
 * 为什么不走 TracerProvider/Tracer：本扩展的 span 是事件驱动“事后组装”的（trace/span id、起止时间在
 * Pi 事件里已经确定，且要和 traceparent 注入、CLS 通道保持同一套 id），用 Tracer.startSpan 无法指定
 * spanId / 历史 startTime。因此直接构造 ReadableSpan 交给官方 processor/exporter，批量、重试、超时、
 * 压缩、OTEL_EXPORTER_OTLP_* 环境变量解析全部复用官方实现。
 *
 * 依赖版本锁在同一条线上（api 1.10 / sdk-trace·resources 3.1 / exporter 0.301）：
 * 旧线 sdk-trace-base 2.x 要求 api <1.10，而 exporter 0.301 要求 api ^1.10，混用会 ERESOLVE。
 */
import { hostname } from "node:os";
import { createRequire } from "node:module";
import type { ReadableSpan, SpanExporter as OtelSpanExporter, SpanProcessor } from "@opentelemetry/sdk-trace";
import type { ResolvedConfig } from "./config.ts";
import type { Logger, SpanExporter } from "./exporters.ts";
import { type CLSSpan, getLocalIp } from "./span.ts";
import { VERSION } from "./version.ts";

// @opentelemetry/api 的枚举值（避免为了常量在运行时多 require 一次）
const SPAN_KIND = { INTERNAL: 0, SERVER: 1, CLIENT: 2 } as const;
const STATUS = { UNSET: 0, OK: 1, ERROR: 2 } as const;
const TRACE_FLAGS_SAMPLED = 1;
const SCOPE = { name: "tencentcloud-agentobs-sdk-pi", version: VERSION };

type HrTime = [number, number];
function nsToHrTime(ns: string): HrTime {
	let n: bigint;
	try {
		n = BigInt(ns || "0");
	} catch {
		n = 0n;
	}
	return [Number(n / 1_000_000_000n), Number(n % 1_000_000_000n)];
}

/** 纯函数：CLSSpan → ReadableSpan，单测/调试可直接用 */
export function toReadableSpan(span: CLSSpan, resource: ReadableSpan["resource"]): ReadableSpan {
	const attributes: Record<string, string | number | boolean> = { ...span.attribute };
	// CLS 顶层字段里 OTLP 没有对应位置的，放进 attributes（不覆盖已有同名属性）
	attributes["gen_ai.span.kind"] ??= span.spanKind;
	if (span.sessionID) attributes["gen_ai.session.id"] ??= span.sessionID;
	if (span.agentID) attributes["gen_ai.agent.id"] ??= span.agentID;
	if (span.stepID) attributes["gen_ai.step.id"] ??= span.stepID;
	const traceId = span.traceID;
	const spanContext = { traceId, spanId: span.spanID, traceFlags: TRACE_FLAGS_SAMPLED };
	return {
		name: span.name,
		kind: SPAN_KIND[span.kind] ?? SPAN_KIND.INTERNAL,
		spanContext: () => spanContext,
		parentSpanContext: span.parentSpanID ? { traceId, spanId: span.parentSpanID, traceFlags: TRACE_FLAGS_SAMPLED, isRemote: false } : undefined,
		startTime: nsToHrTime(span.start),
		endTime: nsToHrTime(span.end),
		duration: nsToHrTime(span.duration),
		// OTel 语义约定：成功时 instrumentation 不设 OK，保持 UNSET；失败设 ERROR + message
		status: span.statusCode === "ERROR" ? { code: STATUS.ERROR, message: span.statusMessage } : { code: STATUS.UNSET },
		attributes,
		links: [],
		events: [],
		ended: true,
		resource,
		instrumentationScope: SCOPE,
		droppedAttributesCount: 0,
		droppedEventsCount: 0,
		droppedLinksCount: 0,
	} as ReadableSpan;
}

export class OtlpExporter implements SpanExporter {
	private readonly processor: SpanProcessor;
	private readonly resource: ReadableSpan["resource"];
	private readonly logger: Logger;
	private readonly debug: boolean;
	private failed = 0;
	private sent = 0;

	constructor(config: ResolvedConfig, logger: Logger) {
		this.logger = logger;
		this.debug = config.debug;
		const require = createRequire(import.meta.url);
		// 仅在选择 otlp 时加载 OTel 包（cls/console 模式零开销）；用 typeof import 保留构造函数签名的类型检查。
		// 两个官方 exporter 构造参数一致，只是序列化不同：-proto → application/x-protobuf（默认），-http → application/json
		const { OTLPTraceExporter } = (
			config.otlpProtocol === "http/json"
				? require("@opentelemetry/exporter-trace-otlp-http")
				: require("@opentelemetry/exporter-trace-otlp-proto")
		) as typeof import("@opentelemetry/exporter-trace-otlp-proto");
		const { BatchSpanProcessor } = require("@opentelemetry/sdk-trace") as typeof import("@opentelemetry/sdk-trace");
		const { resourceFromAttributes } = require("@opentelemetry/resources") as typeof import("@opentelemetry/resources");

		this.resource = resourceFromAttributes({
			"service.name": config.serviceName,
			"service.instance.id": `${config.serviceName}@${getLocalIp()}:${process.pid}`,
			"host.name": hostname(),
			"host.ip": getLocalIp(),
			"process.pid": process.pid,
			"telemetry.sdk.name": "tencentcloud-agentobs-sdk-pi",
			"telemetry.sdk.language": "nodejs",
			"telemetry.sdk.version": VERSION,
			...config.resourceAttributes,
		});

		// 只传显式配置；其余交给官方 exporter 按规范读 OTEL_EXPORTER_OTLP_(TRACES_)ENDPOINT/HEADERS/TIMEOUT/COMPRESSION
		const exporterConfig: Record<string, unknown> = { userAgent: `agentobs-pi/${VERSION}` };
		if (config.otlpEndpoint) exporterConfig.url = config.otlpEndpoint;
		if (config.otlpHeaders) exporterConfig.headers = config.otlpHeaders;
		if (config.otlpTimeoutMs) exporterConfig.timeoutMillis = config.otlpTimeoutMs;
		if (config.otlpCompression) exporterConfig.compression = config.otlpCompression;
		const inner: OtelSpanExporter = new OTLPTraceExporter(exporterConfig);

		// 包一层：官方 processor 把失败交给 OTel diag（默认静默），这里转成我们的告警 + 计数
		const wrapped: OtelSpanExporter = {
			export: (spans, done) =>
				inner.export(spans, (result) => {
					if (result.code === 0) this.sent += spans.length;
					else {
						this.failed += spans.length;
						this.logger.warn(`[agentobs-pi] otlp export failed, ${spans.length} spans lost: ${result.error?.message ?? "unknown error"}`);
					}
					done(result);
				}),
			shutdown: () => inner.shutdown(),
			forceFlush: () => inner.forceFlush?.() ?? Promise.resolve(),
		};

		// 注意：sdk-trace 3.x 的构造签名是单个 options 对象（2.x 是 (exporter, config)，旧写法会被静默忽略）
		this.processor = new BatchSpanProcessor({
			exporter: wrapped,
			maxQueueSize: config.maxQueueSize,
			maxExportBatchSize: Math.min(config.batchMaxSize, config.maxQueueSize),
			scheduledDelayMillis: config.flushIntervalMs,
		});
		if (config.debug) {
			const target = config.otlpEndpoint ?? process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318";
			this.logger.info(`[agentobs-pi] otlp exporter (${config.otlpProtocol}) → ${target}`);
		}
	}

	export(span: CLSSpan): void {
		this.processor.onEnd(toReadableSpan(span, this.resource));
	}

	async flush(): Promise<void> {
		try {
			await this.processor.forceFlush();
		} catch {
			// 失败已在 wrapped.export 里告警
		}
	}

	async shutdown(): Promise<void> {
		try {
			await this.processor.shutdown();
		} catch {
			// ignore
		}
		if (this.debug) this.logger.info(`[agentobs-pi] otlp exporter stopped sent=${this.sent} failed=${this.failed}`);
	}
}
