# Tencent Cloud CLS observability for Pi coding agent

`tencentcloud-agentobs-sdk-pi` 是 [Pi coding agent](https://pi.dev)（`@earendil-works/pi-coding-agent` ≥ 1.3.0）的可观测扩展：订阅 Pi 原生扩展事件，把每次 prompt 转换为腾讯云 AI Agent 可观测规范的 5 层 span（entry → agent → step → chat / tool），支持两种上报通道：

- **CLS 直传**（默认）：通过 `tencentcloud-cls-sdk-js` 直接写入 CLS，无需 OTLP Collector / sidecar。
- **OTLP/HTTP**：通过官方 `@opentelemetry/exporter-trace-otlp-proto`（默认 protobuf）/ `-otlp-http`（JSON）发往任意 OTLP 后端（OTel Collector、Jaeger、Tempo、各云 APM 的 OTLP 接入点）。

与 [`tencentcloud-agentobs-sdk-dsh`](https://www.npmjs.com/package/tencentcloud-agentobs-sdk-dsh) 使用同一套 CLS schema 与环境变量，两者数据可在同一个日志主题里统一分析。

## 数据模型

```text
ENTRY  enter_application                         ← before_agent_start … agent_settled（一次 prompt）
└── AGENT  invoke_agent pi                        ← 汇总 usage / attempts / retries / tool 统计
    ├── STEP  react round_1   (pi.agent.attempt=1) ← turn_start … turn_end
    │   ├── CHAT  chat <model>                    ← before_provider_headers … message_end(assistant)
    │   ├── TOOL  execute_tool read  (call_a)     ← tool_execution_start/end，并行工具按 toolCallId 管理
    │   └── TOOL  execute_tool read  (call_b)
    └── STEP  react round_2
        └── CHAT  chat <model>
```

Pi 自动重试（`retry.enabled`）时，同一个 ENTRY/AGENT 下会出现多个 STEP，每个带 `pi.agent.attempt`，失败那次的 CHAT 为 `ERROR` 且带 `http.response.status_code`。

## 安装

任选一种方式（**只选一种**，见下文「重复上报」）。

```sh
# 1) Pi 包管理（推荐）：写入 ~/.pi/agent/settings.json 的 packages
pi install npm:tencentcloud-agentobs-sdk-pi

# 项目级（写入 .pi/settings.json，需要项目信任）
pi install -l npm:tencentcloud-agentobs-sdk-pi

# 只试用一次，不写配置
pi -e npm:tencentcloud-agentobs-sdk-pi
```

```ts
// 2) 以 SDK 方式嵌入自己的 Pi 应用
import { createAgentSession, DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { createAgentObsExtension } from "tencentcloud-agentobs-sdk-pi";

const resourceLoader = new DefaultResourceLoader({
  cwd, agentDir, settingsManager,
  extensionFactories: [createAgentObsExtension({ serviceName: "my-agent" })],
});
```

> 扩展在 Pi 启动/`/reload` 时加载，修改环境变量后需要重启 Pi。

## 配置

显式传给 `createAgentObsExtension()` 的选项优先于环境变量。

| 选项 | 环境变量 | 默认值 | 说明 |
|---|---|---|---|
| `endpoint` | `CLS_ENDPOINT` | — | CLS 接入点，如 `ap-guangzhou.cls.tencentcs.com`。**不写协议时默认 `https://`**；显式写 `http://` 才会明文（仅限本地联调/内网代理） |
| `topicId` | `CLS_TOPIC_ID` | — | 日志主题 ID |
| `secretId` / `secretKey` | `CLS_SECRET_ID` / `CLS_SECRET_KEY` | — | 强鉴权（推荐） |
| `uin` | `CLS_UIN` | — | 弱鉴权（纯数字 UIN，主题需开启匿名写入），与强鉴权二选一 |
| `serviceName` | `CLS_SERVICE_NAME` / `OTEL_SERVICE_NAME` | `pi-coding-agent` | span 的 `service` 字段 |
| `resourceAttributes` | `OTEL_RESOURCE_ATTRIBUTES` | — | `k=v,k2=v2`，附加到 entry/agent span |
| `captureContent` | `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` | `true` | 是否采集 prompt / 回复 / 工具参数与结果 / system prompt / 工具定义 |
| `contentMaxChars` | `AGENTOBS_CONTENT_MAX_CHARS` | `128000` | 单个内容属性截断长度 |
| `propagateTraceparent` | `AGENTOBS_PROPAGATE_TRACEPARENT` | `false` | 向 LLM 请求注入 W3C `traceparent`（= chat span），用于串联自建 LLM 网关；已有 traceparent 时不覆盖 |
| `exporter` | `AGENTOBS_EXPORTER` → `OTEL_TRACES_EXPORTER` | CLS 配置齐全时 `cls`，否则 `none` | `cls` / `otlp` / `console`（每行一个 JSON）/ `none` |
| `otlpProtocol` | `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL` → `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf` | 仅 `otlp`；`http/protobuf` / `http/json`，`grpc` 告警后按 protobuf 发送 |
| `otlpEndpoint` | `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`（原样）/ `OTEL_EXPORTER_OTLP_ENDPOINT`（自动拼 `/v1/traces`） | `http://localhost:4318/v1/traces` | 仅 `otlp`；选项需写完整 traces 地址 |
| `otlpHeaders` | `OTEL_EXPORTER_OTLP_TRACES_HEADERS` / `OTEL_EXPORTER_OTLP_HEADERS`（`k=v,k2=v2`） | — | 鉴权头等 |
| `otlpTimeoutMs` | `OTEL_EXPORTER_OTLP_TIMEOUT` | `10000` | 单次导出超时 |
| `otlpCompression` | `OTEL_EXPORTER_OTLP_COMPRESSION` | `none` | `gzip` / `none` |
| `consoleFile` | `AGENTOBS_CONSOLE_FILE` | stderr | `console` 导出器的输出文件 |
| `enabled` | `AGENTOBS_ENABLED` | `true` | 总开关 |
| `debug` | `AGENTOBS_DEBUG` | `false` | 输出导出器启动/统计日志 |
| `batchMaxSize` / `maxBatchBytes` / `maxQueueSize` / `flushIntervalMs` / `retryTimes` | — | 32 / 10MB / 2048 / 5000ms / 3 | 批量上报参数；队列满时丢弃最旧 10% |

```sh
export CLS_ENDPOINT=ap-guangzhou.cls.tencentcs.com
export CLS_TOPIC_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
export CLS_SECRET_ID=AKID...
export CLS_SECRET_KEY=...
export CLS_SERVICE_NAME=pi-dev
pi
```

本地先看效果、不上报：

```sh
AGENTOBS_EXPORTER=console AGENTOBS_CONSOLE_FILE=/tmp/pi-spans.jsonl pi -e npm:tencentcloud-agentobs-sdk-pi
```

### 走 OTLP

```sh
export OTEL_TRACES_EXPORTER=otlp                          # 或 AGENTOBS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_ENDPOINT=https://collector.example.com:4318   # 实际请求 …/v1/traces
export OTEL_EXPORTER_OTLP_HEADERS="authorization=Bearer xxx"
# export OTEL_EXPORTER_OTLP_PROTOCOL=http/json             # 默认 http/protobuf，后端只收 JSON 时才需要
export OTEL_SERVICE_NAME=pi-dev
pi
```

CLS 本身兼容 OTLP/HTTP，所以也可以不走 `cls` 直传、改用标准 OTLP exporter 写入同一个日志主题（两条通道的数据可在一个主题里对照，已实测，见 `npm run verify:real`）：

```sh
export AGENTOBS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://ap-guangzhou.cls.tencentcs.com/v1/traces   # 内网用 .cls.tencentyun.com
export OTEL_EXPORTER_OTLP_TRACES_HEADERS="Authorization=Basic $(printf '%s:%s' "$CLS_SECRET_ID" "$CLS_SECRET_KEY" | base64),topic_id=$CLS_TOPIC_ID"
export OTEL_SERVICE_NAME=pi-dev
pi
```

> Endpoint 的地域必须与主题地域一致，否则报 `topic not found`。此时 `statusCode` 成功为 `UNSET`、`kind` 为小写（OTel 语义），与 `cls` 直传的 `OK` / 大写略有差别；其余字段与属性一致。

OTLP 映射说明：
- traceId / spanId / parentSpanId 与 CLS 通道、`traceparent` 注入完全一致；5 层结构通过 `gen_ai.span.kind` 属性区分。
- `kind`：entry=SERVER，chat/tool=CLIENT，agent/step=INTERNAL；失败为 `STATUS_CODE_ERROR` + message，成功保持 `UNSET`（遵循 OTel 约定）。
- CLS 顶层字段 `sessionID` / `agentID` / `stepID` 写入 `gen_ai.session.id` / `gen_ai.agent.id` / `gen_ai.step.id`；`service` / `host` 写入 resource（`service.name`、`host.name`、`host.ip`），`OTEL_RESOURCE_ATTRIBUTES` 同样进 resource。
- 编码默认 OTLP/HTTP **protobuf**（`Content-Type: application/x-protobuf`，官方 `exporter-trace-otlp-proto`，OTel 规范默认值）；`otlpProtocol: "http/json"` 或 `OTEL_EXPORTER_OTLP_PROTOCOL=http/json` 切到 JSON（`exporter-trace-otlp-http`）。不支持 gRPC：设置 `grpc` 时启动告警一次并按 http/protobuf 发送（注意端口应为 4318 而不是 4317）。
- OTel 依赖只在选择 `otlp` 时才加载（`cls` / `console` 模式不 require 任何 `@opentelemetry/*`），且只加载所选协议对应的 exporter。
- 本扩展不注册全局 `TracerProvider`，与宿主或其他扩展的 OTel 实例互不影响；依赖锁定在同一版本线：`@opentelemetry/api ~1.10`、`sdk-trace` / `resources ~3.1`、`exporter-trace-otlp-proto` / `-http ~0.301`（旧线 `sdk-trace-base` 2.x 要求 api < 1.10，不能混用）。

## 主要属性

| span | 关键属性 |
|---|---|
| entry | `gen_ai.session.id`、`gen_ai.turn.id`、`pi.run.end_reason`、`error.type`（`ERROR` / `ABORTED` / `INTERRUPTED`） |
| agent | entry 的公共属性之外，另有 `gen_ai.usage.*`（全部尝试合计）、`pi.agent.attempts`、`pi.agent.retries`、`pi.llm.calls`、`pi.tool.calls`、`pi.tool.errors` |
| step | `gen_ai.react.round`（跨重试连续编号）、`pi.turn_index`（Pi 原生，重试时从 0 重新计数）、`pi.agent.attempt`、`gen_ai.react.finish_reason` |
| chat | `gen_ai.system` / `gen_ai.request.model` / `pi.api`（来自 `ctx.model.provider/id/api`）、`gen_ai.response.model` / `gen_ai.response.id`、`gen_ai.usage.input_tokens`（= input + cacheRead + cacheWrite）、`gen_ai.usage.cache_read.input_tokens`、`gen_ai.response.time_to_first_token_ms`、`http.response.status_code`、`pi.provider.request_id`、`pi.request.prepare_ms`、`gen_ai.request.max_tokens` / `temperature` |
| tool | `gen_ai.tool.name`、`gen_ai.tool.call.id`、`gen_ai.tool.call.arguments` / `result`、`gen_ai.tool.call.duration_ms`、`pi.tool.execute_ms`、`error.type=ToolError` |

## 行为说明（均在 pi-coding-agent@1.3.0 上实测，见 `test/e2e`）

- **agent 级重试**（`retry.enabled`）：每次重试都会再触发一组 `agent_start … agent_end`，但 `before_agent_start` / `agent_settled` 各只一次 → 一个 ENTRY 下多个 attempt。
- **provider 级重试**（`retry.provider.maxRetries`）在 provider SDK 内部完成，扩展只能看到一次请求 → 只有一个 CHAT，重试次数不可见。
- **HTTP 非 2xx 时没有 `after_provider_response` 事件**，状态码从 `assistant.errorMessage` 前缀解析，`pi.provider.request_id` 为空。
- **Prompt cache 预热**（`cacheWarming`）请求没有 `context` / `message_*` 事件，扩展不为其建 span（不会产生孤儿 span），也不改变预热决策。
- **abort**：CHAT 标记 `aborted`，ENTRY/AGENT 记 `ABORTED`，未结束的 tool 以错误关闭。
- 扩展对所有事件只读：始终返回 `undefined`，不修改请求 payload/headers（除非显式开启 `propagateTraceparent`）；内部异常只告警，不影响 agent；上报失败只告警。
- 首个 CHAT 的 `pi.request.prepare_ms` 可能达到数秒，这是 Pi 懒加载 provider SDK 的耗时，不是网络延迟；`time_to_first_token_ms` 从请求真正发出（`before_provider_request`）起算，不含这段时间，但 CHAT span 的总时长包含它。

## 重复上报

- **同一进程内**：同一份扩展被加载多次（例如既 `pi install` 又放进 `~/.pi/agent/extensions`，或文件扩展 + SDK factory 同时存在），通过 `globalThis` 上的会话归属表去重，只有先到的实例上报。
- **与其他可观测扩展并存**（如阿里云 Pilot 等）：无法在代码层面感知，会各自上报一份，请只启用一个。

## 隐私

`captureContent` 默认开启，会上报用户 prompt、模型回复、工具参数与结果（可能包含源码、文件内容、命令输出）以及 system prompt。生产环境如有合规要求，请设置 `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=false`；此时只上报结构、耗时、token 与状态。

## 兼容性

- Pi：`@earendil-works/pi-coding-agent` ≥ 1.3.0（依赖 `before_provider_headers`、`agent_settled`、`context` 等事件）。扩展运行时不 import Pi，只做结构化类型约束。
- Node.js ≥ 22.19（与 Pi 1.3.0 一致）。

## 开发

```sh
npm install
npm run build
npm test          # 端到端：真实 Pi session + mock LLM + mock CLS + mock OTLP Collector（含 ~20s 的 cache warming 用例）
npm run test:fast # 跳过慢用例
npm run demo      # console 导出器，打印 span 调用树
npm run probe     # 只打印 Pi 原始扩展事件时序（不埋点），用于升级 Pi 后复核
npm run verify:real  # 真实环境：npm pack → pi install → 真实 pi CLI 进程 → 真实 CLS 上报 → SearchLog 回查校验
                     # 需要 CLS_*（密钥需有 SearchLog/DescribeIndex 权限）；每个场景自动再跑一遍 OTLP 通道
                     #（默认复用 CLS 自带的 OTLP/HTTP 接入点，REAL_OTLP=0 关闭，REAL_OTLP_ENDPOINT 换自建后端），
                     # 并对比两条通道落库后的结构与关键属性；可选 REAL_LLM_BASE_URL/REAL_LLM_API_KEY/REAL_LLM_MODEL 走真实模型；
                     # --install=pack|dir|ext，--cases=a,b
npm run verify:harness  # 同上的真实 CLS 回查，但走 SDK 内嵌路径（extensionFactories，同进程、无子进程）
npm run probe:llm       # 探测 OpenAI 兼容接入点：chat / tool calling / 流式是否可用
```

真实模型（OpenAI 兼容）可接到上面两个验证上，密钥只经环境变量插值、不落盘：

```sh
REAL_LLM_BASE_URL=https://.../v1 REAL_LLM_MODEL=<model> REAL_LLM_API_KEY=<key> npm run verify:real
```

## License

Apache-2.0
