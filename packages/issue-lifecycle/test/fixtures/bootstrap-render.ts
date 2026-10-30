import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exampleConfig } from "../../../launcher/src/config.ts";
import { materializeDag, type LifecycleDag } from "../../src/materialize.ts";
import { a4sBin } from "./a4s.ts";

const dags: LifecycleDag[] = ["feature.yaml", "poc.yaml", "discovery.yaml", "planning.yaml", "reconcile.yaml"];

/** Test helper: materialize installed templates with fixture config. Bootstrap itself writes the config file. */
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
  const config = exampleConfig({
    lane: "fixture",
    baseBranch: "main",
    gate: "true",
    requiredCheck: "validate",
    testPaths: "test",
    rebaseResolver: "true",
    validation: "",
    blockerReporting: "ask",
    ...(options.codeScanning === "off" ? { codeScanning: "off" as const } : {}),
  });
  const identity = { version: options.version, source: `${options.sourceNwo}@${options.sourceSha}`, executable: a4sBin };
  for (const name of dags) writeFileSync(join(options.directory, name), materializeDag(options.packageDir, name, config, identity));
}
