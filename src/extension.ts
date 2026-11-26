/**
 * Pi 扩展入口：export default function (pi: ExtensionAPI)
 * 由 package.json 的 "pi.extensions" 声明，`pi install npm:tencentcloud-agentobs-sdk-pi` 后自动加载；
 * 也可直接放到 ~/.pi/agent/extensions/ 或 settings.json 的 extensions 中。
 * 所有配置来自环境变量（CLS_* / OTEL_* / AGENTOBS_*）。
 */
import { createAgentObsExtension } from "./index.ts";

export default createAgentObsExtension();
