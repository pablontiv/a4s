import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const template = readFileSync(new URL("../skills/dagu-feature/reconcile.yaml", import.meta.url), "utf8");
const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;
// The same jq substitutions used by bootstrap's reconcile render, in an isolated destination.
const rendered = execFileSync("jq", ["-nr", "--arg", "template", template, "--arg", "version", version,
  "--arg", "stamp", `@a4s/omp-dagu@${version} source=test/repo@${"a".repeat(40)} bootstrap=test dagu=2.20.1`,
  "--arg", "identity", "test", '$template | gsub("__DAGU_FEATURE_STAMP__"; $stamp) | gsub("__DAGU_FEATURE_VERSION__"; $version) | gsub("__DAGU_FEATURE_IDENTITY__"; $identity)'], { encoding: "utf8" });

for (const [name, definition] of [["template", template], ["current isolated render", rendered]]) {
  const lines = definition!.split("\n");
  const start = lines.indexOf("  - id: unowned");
  assert.ok(start >= 0);
  assert.equal(lines[start + 1], "    depends: discover");
  const run = lines.indexOf("    run: |", start);
  let end = run + 1;
  while (end < lines.length && (lines[end]!.startsWith("      ") || lines[end] === "")) end++;
  const script = lines.slice(run + 1, end).map(line => line.slice(6)).join("\n");

  function fixture(owner: string, mode: string, extra: Record<string, string> = {}) {
    const root = mkdtempSync(join(tmpdir(), "unowned301-"));
    const bin = join(root, "bin");
    mkdirSync(bin);
    const locks = join(root, "custom-locks");
    mkdirSync(locks);
    writeFileSync(join(locks, "dead.lock"), "file existence is not ownership\n");
    writeFileSync(join(root, "history"), JSON.stringify([{ dagRunId: "waiting-run", startedAt: "2026-10-21T00:00:00Z", params: `QUESTION=multiple words ${extra.RETAINED_PRIMARY === "yes" ? "" : "PRIMARY=/tmp/repo "}OMP_SESSION_ID=${owner} ISSUE=301` }]));
    writeFileSync(join(bin, "dagu"), `#!/bin/bash\nprintf '%s\\n' "$*" >>"$ROOT/calls"\ncase "$1" in\nhistory) [[ "$*" == "history $2 --status waiting --format json --limit 500" ]] || exit 2; [[ "$HISTORY_ERROR" != yes ]] || { echo history-error >&2; exit 2; }; cat "$ROOT/history";;\nstatus) [[ "$*" == "status --run-id waiting-run $4" ]] || exit 2; [[ "$STATUS_ERROR" != yes ]] || { echo status-error >&2; exit 2; }; printf 'Waiting - now\\n\\ndag: %s (0s)\\n└─review [waiting]\\n  ├─step id: review\\n  └─prompt: Native human task\\n\\nResult: Waiting\\n' "$4";;\n*) exit 2;;\nesac\n`);
    writeFileSync(join(bin, "lsof"), `#!/bin/bash\nprintf '%s\\n' "$*" >>"$ROOT/lsof-calls"\n[[ "$*" == "-F pc $EXPECTED_LOCKS/$OWNER.lock" ]] || exit 2\ncase "$MODE" in\nlive) printf 'p123\\ncbun\\nf48\\n';;\ndead) exit 1;;\npermission) echo 'lsof: permission denied' >&2; exit 1;;\nwarning) printf 'p123\\ncbun\\n'; echo 'lsof: warning' >&2;;\nmalformed) echo garbage;;\nempty-success) exit 0;;\ncommand-error) exit 127;;\ncontradiction) echo p123; exit 1;;\nesac\n`);
    chmodSync(join(bin, "dagu"), 0o755);
    chmodSync(join(bin, "lsof"), 0o755);
    writeFileSync(join(root, "spec"), JSON.stringify({ spec: 'env:\n  - PRIMARY: "/historical/retained-repo"\n' }));
    writeFileSync(join(bin, "curl"), `#!/bin/bash\nprintf '%s\\n' "$*" >>"$ROOT/curl-calls"\n[[ "$1" == -fsS && "$2" =~ ^http://127.0.0.1:[0-9]+/api/v1/dag-runs/(feature|poc|discovery)/waiting-run/spec$ ]] || exit 2\n[[ "$SPEC_ERROR" != yes ]] || { echo retained-spec-unavailable >&2; exit 22; }\ncat "$ROOT/spec"\n`);
    chmodSync(join(bin, "curl"), 0o755);
    const env = { ...process.env, HOME: root, ROOT: root, PATH: `${bin}:${process.env.PATH}`, OMP_SESSION_LOCKS: locks, EXPECTED_LOCKS: locks, OWNER: owner, MODE: mode, ...extra };
    if (extra.DEFAULT_LOCKS === "yes") {
      env.OMP_SESSION_LOCKS = "";
      env.EXPECTED_LOCKS = join(root, ".omp/run/session-owners");
    }
    try {
      const before = readFileSync(join(root, "history"), "utf8");
      const result = spawnSync("bash", ["-c", script], { env, encoding: "utf8" });
      assert.equal(readFileSync(join(root, "history"), "utf8"), before);
      assert.equal(result.stdout, "");
      return { ...result, calls: readFileSync(join(root, "calls"), "utf8"), lsofCalls: existsSync(join(root, "lsof-calls")) ? readFileSync(join(root, "lsof-calls"), "utf8") : "" };
    } finally { rmSync(root, { recursive: true, force: true }); }
  }

  test(`${name}: live process-held owner is retained across all DAG families`, () => {
    const result = fixture("live", "live");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    for (const kind of ["feature", "poc", "discovery"]) assert.ok(result.calls.includes(`history ${kind} --status waiting --format json --limit 500`));
  });
  for (const owner of ["dead", ""]) test(`${name}: exact read-only reports for ${owner || "empty"} owner in all families`, () => {
    const result = fixture(owner, "dead");
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stderr, ["feature", "poc", "discovery"].map(kind => `UNOWNED repo waiting-run dag=${kind} step=review owner=${owner || "none"} since=2026-10-21T00:00:00Z\n`).join(""));
  });
  for (const mode of ["permission", "warning", "malformed", "empty-success", "command-error", "contradiction"]) test(`${name}: ${mode} is visible and indeterminate`, () => {
    const result = fixture("uncertain", mode);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unowned: (lsof diagnostic|ambiguous lsof result)/);
  });
  test(`${name}: default session-owner lock directory`, () => {
    const result = fixture("live", "live", { DEFAULT_LOCKS: "yes" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.lsofCalls, /\/\.omp\/run\/session-owners\/live\.lock/);
  });
  for (const source of ["HISTORY_ERROR", "STATUS_ERROR"]) test(`${name}: ${source} fails visibly before ownership classification`, () => {
    const result = fixture("live", "live", { [source]: "yes" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /(?:history|status)-error/);
    assert.equal(result.lsofCalls, "");
  });
  test(`${name}: adopted PRIMARY comes from each historical retained spec`, () => {
    const result = fixture("dead", "dead", { RETAINED_PRIMARY: "yes" });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stderr, ["feature", "poc", "discovery"].map(kind => `UNOWNED retained-repo waiting-run dag=${kind} step=review owner=dead since=2026-10-21T00:00:00Z\n`).join(""));
  });
  test(`${name}: unavailable retained spec fails visibly`, () => {
    const result = fixture("dead", "dead", { RETAINED_PRIMARY: "yes", SPEC_ERROR: "yes" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /retained-spec-unavailable/);
    assert.equal(result.lsofCalls, "");
  });
}
