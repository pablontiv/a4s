import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Installed-package boundary fixture; discovery requires the actual consumer cwd. */
export function roleRuntimeFixture(root: string, names = ["triage-reviewer", "task"]): string {
  const runtime = join(root, "runtime");
  mkdirSync(join(runtime, "src/config"), { recursive: true });
  mkdirSync(join(runtime, "src/task"), { recursive: true });
  writeFileSync(join(runtime, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version: "0.0.0-test", type: "module" }));
  for (const relative of ["config/settings.ts", "task/settings.ts", "config/model-resolver.ts", "task/executor.ts"]) {
    writeFileSync(join(runtime, "src", relative), "throw new Error('detect must not launch the executor or load model settings');\n");
  }
  writeFileSync(join(runtime, "src/task/discovery.ts"), `import { readFileSync } from "node:fs";
import { join } from "node:path";
export async function discoverAgents(cwd) {
  const names = JSON.parse(readFileSync(join(cwd, "agents.json"), "utf8"));
  return { agents: names.map(name => ({ name, source: "fixture:" + cwd, systemPrompt: "fixture" })) };
}
`);
  writeFileSync(join(root, "agents.json"), JSON.stringify(names));
  return runtime;
}
