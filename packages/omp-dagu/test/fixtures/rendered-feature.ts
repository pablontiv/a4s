import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { fileURLToPath } from "node:url";
import { BUNDLE_VERSION, REQUIRED_DAGU_VERSION } from "../../src/bundle.ts";

const root = mkdtempSync(join(tmpdir(), "omp-dagu-rendered-feature-"));
const skill = fileURLToPath(new URL("../../skills/dagu-feature/", import.meta.url));
const bootstrap = readFileSync(join(skill, "dagu-feature-bootstrap.yaml"), "utf8");
const render = bootstrap.split("  - id: render\n")[1]!.split("\n  - id: reconcile")[0]!;
const script = render.split("    run: |\n")[1]!.split("      jq -nr --rawfile template \"$SKILL_DIR/poc.yaml\"")[0]!
  .split("\n").map(line => line.slice(6)).join("\n");
export const renderedFeature = join(root, "feature.yaml");
after(() => rmSync(root, { recursive: true, force: true }));
execFileSync("bash", ["-c", script], {
  encoding: "utf8",
  env: {
    ...process.env, PRIMARY: root, SKILL_DIR: skill, STAGE: renderedFeature,
    DAG_RUN_ID: "rendered-feature-fixture", REPO: "fixture", BASE_BRANCH: "main",
    GATE: "true", REQUIRED_CHECK: "validate", REBASE_RESOLVER: "true", VALIDATION: "",
    A4S_BLOCKER_REPORTING: "ask", BUNDLE_NAME: "@a4s/omp-dagu", BUNDLE_VERSION,
    DAGU_VERSION: REQUIRED_DAGU_VERSION, SOURCE_NWO: "fixture/repo", SOURCE_SHA: "a".repeat(40),
  },
});
