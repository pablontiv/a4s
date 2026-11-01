import assert from "node:assert/strict";
import test from "node:test";
import { select } from "../../../scripts/ci-workspaces.mjs";

const workspaces = [
  { dir: "packages/tools", name: "@a4s/tools", test: true, typecheck: true, dependencies: [] },
  { dir: "packages/tools/routing", name: "@a4s/review-routing", test: false, typecheck: true, dependencies: [] },
  { dir: "apps/message-bus", name: "@a4s/message-bus", test: true, typecheck: false,
    dependencies: ["@a4s/review-routing"] },
  { dir: "packages/issue-lifecycle", name: "@a4s/issue-lifecycle", test: true, typecheck: true,
    dependencies: ["@a4s/message-bus"] },
  { dir: "packages/hot-reload", name: "@a4s/hot-reload", test: true, typecheck: true, dependencies: [] },
];
const jobs = (names: string[]) => workspaces.filter(workspace => names.includes(workspace.name))
  .map(({ name, test, typecheck }) => ({ name, test, typecheck }))
  .sort((a, b) => a.name.localeCompare(b.name));
const all = jobs(workspaces.map(workspace => workspace.name));

test("CI selection uses longest ownership and propagates declared dependencies transitively", () => {
  assert.deepEqual(select(["packages/tools/README.md"], workspaces, "pull_request"), jobs(["@a4s/tools"]));
  assert.deepEqual(select(["packages/tools/routing/src/index.ts"], workspaces, "pull_request"),
    jobs(["@a4s/review-routing", "@a4s/message-bus", "@a4s/issue-lifecycle"]));
  assert.deepEqual(select(["packages/tools/routing/src/index.ts"], [...workspaces].reverse(), "pull_request"),
    jobs(["@a4s/review-routing", "@a4s/message-bus", "@a4s/issue-lifecycle"]));
  assert.deepEqual(select(["apps/message-bus/src/index.ts"], workspaces, "pull_request"),
    jobs(["@a4s/message-bus", "@a4s/issue-lifecycle"]));
  assert.deepEqual(select([], workspaces, "pull_request"), []);
});

test("CI selection includes both rename sides and paginated GitHub file records", () => {
  assert.deepEqual(select([[{ filename: "apps/message-bus/src/new.ts",
    previous_filename: "packages/tools/src/old.ts" }]], workspaces, "pull_request"),
  jobs(["@a4s/tools", "@a4s/message-bus", "@a4s/issue-lifecycle"]));
});

test("CI shared, deleted, moved and hot-reload paths select every current workspace", () => {
  for (const path of ["package.json", "package-lock.json", "tsconfig.json", ".github/workflows/ci.yml",
    "scripts/ci-workspaces.mjs", "scripts/bootstrap.sh", "packages/README.md",
    "packages/removed-workspace/src/old.ts", "packages/tools-extra/src/index.ts",
    "apps/removed-app/src/index.ts", "packages/hot-reload/src/index.ts"]) {
    assert.deepEqual(select([path], workspaces, "pull_request"), all, path);
  }
  assert.deepEqual(select([{ filename: "apps/message-bus/src/new.ts",
    previous_filename: "packages/removed-workspace/src/old.ts" }], workspaces, "pull_request"), all);
});

test("CI non-PR events select all workspaces without changed files", () => {
  for (const event of ["push", "workflow_dispatch", undefined]) {
    assert.deepEqual(select([], workspaces, event), all, String(event));
  }
});
