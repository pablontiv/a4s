import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exampleAnswers } from "../../src/answers.ts";
import { materializeDag, type LifecycleDag } from "../../src/materialize.ts";

const dags: LifecycleDag[] = ["feature.yaml", "poc.yaml", "discovery.yaml", "planning.yaml", "reconcile.yaml"];

/** Test helper: materialize installed templates with fixture answers. Bootstrap itself writes the answers file. */
export function bootstrapRender(options: {
  packageDir: string;
  directory: string;
  primary: string;
  version: string;
  sourceNwo: string;
  sourceSha: string;
  codeScanning?: string;
}): void {
  mkdirSync(options.directory, { recursive: true });
  const requested = Number(process.env.QUEUE_CONCURRENCY ?? 1);
  const answers = exampleAnswers({
    lane: "fixture",
    baseBranch: "main",
    queueConcurrency: Number.isSafeInteger(requested) && requested > 0 ? requested : 1,
    gate: "true",
    requiredCheck: "validate",
    testPaths: "test",
    rebaseResolver: "true",
    validation: "",
    blockerReporting: "ask",
    ...(options.codeScanning === "off" ? { codeScanning: "off" as const } : {}),
  });
  const identity = { version: options.version, source: `${options.sourceNwo}@${options.sourceSha}` };
  for (const name of dags) writeFileSync(join(options.directory, name), materializeDag(options.packageDir, name, answers, identity));
}
