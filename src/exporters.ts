/**
 * Span 导出器：
 *  - ClsExporter：通过 tencentcloud-cls-sdk-js 批量直传 CLS（与 dsh 版字段布局一致）
 *  - OtlpExporter（./otlp.ts）：官方 @opentelemetry/exporter-trace-otlp-proto（默认，http/protobuf）或 -otlp-http（http/json）
 *  - ConsoleExporter：每个 span 一行 JSON，写 stderr 或 AGENTOBS_CONSOLE_FILE（TUI 模式下请用文件，避免花屏）
 *  - MemoryExporter：测试用
 */
import { appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { ResolvedConfig } from "./config.ts";
import { OtlpExporter } from "./otlp.ts";
import { type CLSSpan, getLocalIp } from "./span.ts";
import { VERSION } from "./version.ts";

export interface SpanExporter {
	export(span: CLSSpan): void;
	flush(): Promise<void>;
	shutdown(): Promise<void>;
}

export interface Logger {
	info(msg: string): void;
	warn(msg: string): void;
}

export const stderrLogger: Logger = {
	info: (m) => process.stderr.write(`${m}\n`),
	warn: (m) => process.stderr.write(`${m}\n`),
};

export class NoopExporter implements SpanExporter {
	export(): void {}
	async flush(): Promise<void> {}
	async shutdown(): Promise<void> {}
}

export class MemoryExporter implements SpanExporter {
	readonly spans: CLSSpan[] = [];
	export(span: CLSSpan): void {
		this.spans.push(span);
	}
	async flush(): Promise<void> {}
	async shutdown(): Promise<void> {}
	reset(): void {
		this.spans.length = 0;
	}
}

export class ConsoleExporter implements SpanExporter {
	private readonly file: string;
	constructor(file = "") {
		this.file = file;
	}
	export(span: CLSSpan): void {
		const line = `${JSON.stringify(span)}\n`;
		if (this.file) appendFileSync(this.file, line);
		else process.stderr.write(line);
	}
	async flush(): Promise<void> {}
	async shutdown(): Promise<void> {}
}

export class ClsExporter implements SpanExporter {
	private client: any;
	private queue: CLSSpan[] = [];
	private timer: NodeJS.Timeout | undefined;
	private inFlight: Promise<void> | undefined;
	private sent = 0;
	private failed = 0;
	private dropped = 0;
	private readonly sdk: any;
	private readonly config: ResolvedConfig;
	private readonly logger: Logger;

	constructor(config: ResolvedConfig, logger: Logger = stderrLogger) {
		this.config = config;
		this.logger = logger;
		// CLS SDK 是 CJS；仅在选择 cls 导出器时才加载（console/none 模式不依赖 protobufjs）
		const require = createRequire(import.meta.url);
		this.sdk = require("tencentcloud-cls-sdk-js");
		this.client = new this.sdk.AsyncClient({
			endpoint: config.endpoint,
			secretId: config.secretId,
			secretKey: config.secretKey,
			uin: config.uin,
			user_agent: `agentobs-pi-${VERSION}`,
			sourceIp: getLocalIp(),
			retry_times: config.retryTimes,
		});
		this.timer = setInterval(() => void this.flush(), config.flushIntervalMs);
		this.timer.unref();
		if (config.debug) this.logger.info(`[agentobs-pi] cls exporter → ${config.endpoint} topic=${config.topicId.slice(0, 8)}...`);
	}

	export(span: CLSSpan): void {
		if (this.queue.length >= this.config.maxQueueSize) {
			const n = Math.max(1, Math.floor(this.config.maxQueueSize * 0.1));
			this.queue.splice(0, n);
			this.dropped += n;
			this.logger.warn(`[agentobs-pi] queue full, dropped ${n} oldest span(s), total dropped=${this.dropped}`);
		}
		this.queue.push(span);
		if (this.queue.length >= this.config.batchMaxSize) void this.flush();
	}

	flush(): Promise<void> {
		if (this.inFlight) return this.inFlight;
		if (this.queue.length === 0) return Promise.resolve();
		this.inFlight = this.drain().finally(() => {
			this.inFlight = undefined;
		});
		return this.inFlight;
	}

	async shutdown(): Promise<void> {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		for (let i = 0; i < 5 && this.queue.length > 0; i++) {
			const before = this.queue.length;
			await this.flush();
			if (this.queue.length === before) break;
		}
		if (this.config.debug) this.logger.info(`[agentobs-pi] cls exporter stopped sent=${this.sent} failed=${this.failed} dropped=${this.dropped}`);
	}

	private async drain(): Promise<void> {
		while (this.queue.length > 0) {
			const batch: CLSSpan[] = [];
			let bytes = 0;
			while (this.queue.length > 0 && batch.length < this.config.batchMaxSize) {
				const size = Buffer.byteLength(JSON.stringify(this.queue[0]), "utf8");
				if (batch.length > 0 && bytes + size > this.config.maxBatchBytes) break;
				batch.push(this.queue.shift()!);
				bytes += size;
			}
			try {
				await this.send(batch);
				this.sent += batch.length;
			} catch (err: any) {
				this.failed += batch.length;
				this.logger.warn(`[agentobs-pi] upload failed (${err?.code ?? err?.statusCode ?? "unknown"}), ${batch.length} spans lost: ${err?.message ?? err}`);
			}
		}
	}

	private async send(spans: CLSSpan[]): Promise<void> {
		const { LogGroup, LogItem, Content, PutLogsRequest } = this.sdk;
		const group = new LogGroup();
		for (const span of spans) {
			const item = new LogItem();
			for (const [k, v] of Object.entries(span)) {
				item.pushBack(new Content(k, k === "attribute" ? JSON.stringify(v) : String(v)));
			}
			const startNs = span.start ? BigInt(span.start) : 0n;
			item.setTime(startNs > 0n ? Number(startNs / 1_000_000_000n) : Math.floor(Date.now() / 1000));
			group.addLogs(item);
		}
		await this.client.PutLogs(new PutLogsRequest(this.config.topicId, group));
	}
}

export function createExporter(config: ResolvedConfig, logger: Logger = stderrLogger): SpanExporter {
	switch (config.exporter) {
		case "cls":
			return new ClsExporter(config, logger);
		case "otlp":
			return new OtlpExporter(config, logger);
		case "console":
			return new ConsoleExporter(config.consoleFile);
		default:
			return new NoopExporter();
	}
}
