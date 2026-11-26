# Changelog

## 0.1.0

首个版本，适配 `@earendil-works/pi-coding-agent` 1.3.0。

- 5 层 span 模型（entry → agent → step → chat / tool），CLS schema 与 `tencentcloud-agentobs-sdk-dsh` 0.1.0 一致，通过 `tencentcloud-cls-sdk-js` 直传。
- 新增 `otlp` 导出器：基于官方 `@opentelemetry/exporter-trace-otlp-proto` / `-otlp-http` 0.301 + `sdk-trace` 3.1 的 `BatchSpanProcessor`；默认 OTLP/HTTP protobuf，可用 `otlpProtocol` / `OTEL_EXPORTER_OTLP_(TRACES_)PROTOCOL` 切到 `http/json`，`grpc` 告警并降级；支持 `OTEL_TRACES_EXPORTER`、`OTEL_EXPORTER_OTLP_*` 标准环境变量；OTel 依赖按需懒加载。
- 正确处理 Pi agent 级自动重试（一个 entry 多个 attempt）、provider 级重试、HTTP 错误（无 `after_provider_response`）、abort、并行工具、prompt cache 预热请求（不建 span）。
- usage 还原：`input_tokens = input + cacheRead + cacheWrite`。
- 可选 W3C `traceparent` 注入（默认关闭）。
- 同一进程内多次加载自动去重；按导出目标共享上报队列。
- CLS 接入点不写协议时默认 HTTPS（dsh 0.1.0 会剥掉协议，导致 CLS SDK 回落到明文 HTTP）。
- 支持 `pi install npm:` / `pi -e` / SDK `extensionFactories` 三种接入方式。
