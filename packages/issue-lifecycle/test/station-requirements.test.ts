import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const packageDir = fileURLToPath(new URL("../", import.meta.url));
const skillDir = join(packageDir, "skills", "issue-execution");
const renders = ["feature.yaml", "poc.yaml", "discovery.yaml", "planning.yaml", "reconcile.yaml"];

function packageBins(): string[] {
  return Object.keys(JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).bin as Record<string, string>);
}

/** Package executables invoked by a rendered lifecycle DAG, ignoring stamps and comments. */
export function renderPackageBins(sources: ReadonlyMap<string, string>, bins: readonly string[]): string[] {
  const called = new Set<string>();
  for (const source of sources.values()) {
    const lines = source.split("\n").filter(line => !line.trimStart().startsWith("#") && !bins.some(bin => line.includes(`${bin}=`)));
    const text = lines.join("\n");
    for (const bin of bins) {
      if (new RegExp(`(?:^|[^A-Za-z0-9_-])${bin}(?:[^A-Za-z0-9_-]|$)`, "m").test(text)) called.add(bin);
    }
  }
  return [...called].sort();
}

export function unverifiedRenderBins(called: readonly string[], verified: readonly string[]): string[] {
  const have = new Set(verified);
  return called.filter(bin => !have.has(bin));
}

function bootstrap(): { steps: Array<{ id: string; run?: string }> } {
  return parse(readFileSync(join(skillDir, "dagu-feature-bootstrap.yaml"), "utf8")) as { steps: Array<{ id: string; run?: string }> };
}

function detectTools(script: string): string[] {
  const match = /for tool in ([^;\n]+); do/.exec(script);
  assert.ok(match?.[1], "detect must name the commands it verifies");
  return match[1].trim().split(/\s+/);
}

test("bootstrap detect verifies every package executable a rendered DAG calls", () => {
  const bins = packageBins();
  const sources = new Map(renders.map(name => [name, readFileSync(join(skillDir, name), "utf8")]));
  const called = renderPackageBins(sources, bins);
  const script = bootstrap().steps.find(step => step.id === "detect")?.run ?? "";
  const tools = detectTools(script);
  assert.ok(called.includes("dagu-gate"));
  assert.ok(called.includes("dagu-stale-recovery"));
  assert.deepEqual(unverifiedRenderBins(called, tools), []);
  assert.deepEqual(unverifiedRenderBins(["dagu-gate"], tools.filter(tool => tool !== "dagu-gate")), ["dagu-gate"]);
  const requirements = readFileSync(join(skillDir, "SKILL.md"), "utf8").split("## Requirements\n")[1]?.split("\n## ")[0] ?? "";
  for (const bin of called) assert.match(requirements, new RegExp(`\`${bin}\``));
  assert.match(script, /bootstrap detect: required command not found: %s/);
});

test("bootstrap detect fails with the missing render executable's name", () => {
  const root = mkdtempSync(join(tmpdir(), "a4s-detect-"));
  try {
    const bin = join(root, "bin");
    mkdirSync(bin);
    const script = bootstrap().steps.find(step => step.id === "detect")?.run ?? "";
    for (const tool of detectTools(script).filter(tool => tool !== "dagu-gate")) {
      writeFileSync(join(bin, tool), "#!/bin/sh\nexit 0\n");
      chmodSync(join(bin, tool), 0o755);
    }
    const result = spawnSync("bash", ["-c", script], { encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin` } });
    assert.notEqual(result.status, 0, result.stderr);
    assert.match(result.stderr, /bootstrap detect: required command not found: dagu-gate/, result.stderr);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
