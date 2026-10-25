import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function bootstrapRender(options: {
  packageDir: string;
  directory: string;
  primary: string;
  version: string;
  sourceNwo: string;
  sourceSha: string;
  codeScanning?: string;
}): void {
  const skill = join(options.packageDir, "skills", "issue-execution");
  const manifest = JSON.parse(readFileSync(join(options.packageDir, "package.json"), "utf8"));
  const bootstrap = readFileSync(join(skill, "dagu-feature-bootstrap.yaml"), "utf8");
  // Execute the maintained rendering body; full native validation is exercised by live tests.
  const render = bootstrap.split("  - id: render\n")[1]!.split("\n  - id: reconcile")[0]!;
  const script = render.split("    run: |\n")[1]!.split("      for rendered in")[0]!
    .split("\n").map(line => line.slice(6)).join("\n");
  execFileSync("bash", ["-c", script], {
    encoding: "utf8",
    env: {
      ...process.env, PRIMARY: options.primary, SKILL_DIR: skill,
      STAGE: join(options.directory, "feature.yaml"), DAG_RUN_ID: "bootstrap-fixture",
      REPO: "fixture", BASE_BRANCH: "main", GATE: "true", REQUIRED_CHECK: "validate",
      REBASE_RESOLVER: "true", VALIDATION: "", TEST_PATHS: "test", A4S_BLOCKER_REPORTING: "ask",
      ...(options.codeScanning !== undefined ? { CODE_SCANNING: options.codeScanning } : {}),
      BUNDLE_NAME: manifest.name, BUNDLE_VERSION: options.version,
      DAGU_VERSION: manifest.daguFeature.dagu, SOURCE_NWO: options.sourceNwo, SOURCE_SHA: options.sourceSha,
    },
  });
}
