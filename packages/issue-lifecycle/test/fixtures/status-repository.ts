import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { BUNDLE_VERSION } from "../../src/bundle.ts";

// Match the fake Dagu workspace through an owned origin, independently of the checkout.
export const statusRepository = mkdtempSync(join(tmpdir(), "dagu-status-fixture-"));
after(() => rmSync(statusRepository, { recursive: true, force: true }));
execFileSync("git", ["init", statusRepository], { stdio: "ignore" });
execFileSync("git", ["-C", statusRepository, "remote", "add", "origin", "https://github.com/pablontiv/a4s.git"]);
mkdirSync(join(statusRepository, "packages/issue-lifecycle"), { recursive: true });
writeFileSync(join(statusRepository, "packages/issue-lifecycle/package.json"), JSON.stringify({ version: BUNDLE_VERSION }));
