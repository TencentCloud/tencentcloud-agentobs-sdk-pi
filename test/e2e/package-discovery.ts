// 以“包目录”方式加载（等价于 pi install ./tencentcloud-agentobs-sdk-pi）：
// Pi 通过 package.json 的 pi.extensions 清单发现 dist/extension.js，而不是直接给文件路径。
import fs from "node:fs";
import path from "node:path";
import { createHarness } from "./harness.ts";
import { renderTrees } from "./tree.ts";

const pkgDir = path.resolve(import.meta.dirname, "../..");
const out = path.join(pkgDir, ".tmp", `pkgdir-${Date.now()}.jsonl`);
process.env.AGENTOBS_EXPORTER = "console";
process.env.AGENTOBS_CONSOLE_FILE = out;

const h = await createHarness({ extensionPaths: [pkgDir] });
h.llm.script({ kind: "tools", calls: [{ id: "c1", name: "read", args: { path: "a.txt" } }] }, { kind: "text", text: "done" });
await h.session.prompt("read a.txt");
await h.close();
await new Promise((r) => setTimeout(r, 200));
const spans = fs.readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
console.log(`package dir: ${pkgDir}\nspans: ${spans.length}`);
console.log(renderTrees(spans));
process.exit(spans.length === 7 ? 0 : 1);
