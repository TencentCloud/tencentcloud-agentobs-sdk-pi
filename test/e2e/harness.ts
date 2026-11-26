// 公共测试夹具：临时 agentDir + models.json 指向目标 provider，用真实的 pi-coding-agent@1.3.0 SDK 建 session。
// createHarness()     → provider 指向本进程内的 MockLLM（e2e 默认）
// createRealHarness() → provider 指向调用方给定的真实接入点（test/real 用，无 MockLLM）
import fs from "node:fs";
import path from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
// 这两个内存实现未从包入口导出（exports 只有 "."），测试里按文件路径直接引用
import { AuthStorage } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js";
import { InMemoryCodingAgentModelsStore } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/models-store.js";
import { MockLLM } from "./mock-server.ts";

export interface ProviderSpec {
	/** provider 名（models.json 的 key，同时用于 --model <provider>/<id>） */
	name: string;
	baseUrl: string;
	/** pi 的 provider api 类型，默认 openai-completions */
	api?: string;
	/** 支持 "$ENV_NAME" 插值，避免真实密钥落盘 */
	apiKey: string;
	modelId: string;
}

/** pi 的 Settings 未从包入口导出，按 SettingsManager.inMemory 的签名推导 */
type PiSettings = NonNullable<Parameters<typeof SettingsManager.inMemory>[0]>;

export interface HarnessOptions {
	extensionPaths?: string[];
	factories?: ExtensionFactory[];
	settings?: PiSettings;
	modelExtra?: Record<string, unknown>;
}

interface BuildOptions extends HarnessOptions {
	provider: ProviderSpec;
}

async function build(opts: BuildOptions) {
	// 放在包目录下的 .tmp 而不是系统 tmpdir（本机安全策略禁止删除系统临时目录里的锁文件）
	const tmpBase = path.resolve(import.meta.dirname, "../../.tmp");
	fs.mkdirSync(tmpBase, { recursive: true });
	const root = fs.mkdtempSync(path.join(tmpBase, "run-"));
	const agentDir = path.join(root, "agent");
	const cwd = path.join(root, "work");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(cwd, { recursive: true });
	fs.writeFileSync(path.join(cwd, "a.txt"), "hello from a\n");
	fs.writeFileSync(path.join(cwd, "b.txt"), "hello from b\n");
	const p = opts.provider;
	const modelsPath = path.join(agentDir, "models.json");
	fs.writeFileSync(
		modelsPath,
		JSON.stringify({
			providers: {
				[p.name]: {
					baseUrl: p.baseUrl,
					api: p.api ?? "openai-completions",
					apiKey: p.apiKey,
					models: [{ id: p.modelId, name: p.modelId, contextWindow: 128000, maxTokens: 4096, ...(opts.modelExtra ?? {}) }],
				},
			},
		}),
	);
	// 凭据/模型缓存用内存实现，避免 proper-lockfile 在临时目录里建删锁文件
	const modelRuntime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsStore: new InMemoryCodingAgentModelsStore(),
		modelsPath,
		allowModelNetwork: false,
	});
	const model = modelRuntime.getModel(p.name, p.modelId);
	if (!model) throw new Error(`model not registered: ${p.name}/${p.modelId}`);
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: true, maxRetries: 2, baseDelayMs: 50 },
		...(opts.settings ?? {}),
	});
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		additionalExtensionPaths: opts.extensionPaths ?? [],
		extensionFactories: opts.factories ?? [],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();
	const ext = resourceLoader.getExtensions();
	if (ext.errors.length) throw new Error(`extension load errors: ${JSON.stringify(ext.errors)}`);
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model,
		thinkingLevel: "off",
		modelRuntime,
		resourceLoader,
		settingsManager,
		sessionManager: SessionManager.inMemory(cwd),
		tools: ["read"],
	});
	await session.bindExtensions({});
	// 不主动删除 .tmp/run-*（本机 safe-delete 策略会拦截批量删除），由 .gitignore 忽略
	return { session, model, cwd, agentDir };
}

export async function createHarness(opts: HarnessOptions = {}) {
	const llm = new MockLLM();
	await llm.start();
	const h = await build({ ...opts, provider: { name: "mock", baseUrl: llm.url, apiKey: "sk-mock", modelId: "mock-gpt" } });
	return {
		llm,
		...h,
		async close() {
			h.session.dispose();
			await llm.stop();
		},
	};
}

/** 真实 provider 版本：没有 MockLLM，其余与 createHarness 一致 */
export async function createRealHarness(opts: HarnessOptions & { provider: ProviderSpec }) {
	const h = await build(opts);
	return {
		...h,
		async close() {
			h.session.dispose();
		},
	};
}
