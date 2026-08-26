import assert from "node:assert/strict";
import { test } from "node:test";
import { registrationHash } from "../../launcher/src/contracts.ts";
import { harness, selection } from "./fixtures.ts";

for (const change of ["command", "helper", "loader", "launcher", "skills", "agents"] as const) {
  test(`${change} change prompts restart before leasing or importing`, async t => {
    const h = harness(); t.after(() => h.loader.dispose());
    await h.loader.initialize(); await h.host.emit("session_start", h.context);
    const candidate = selection(2);
    if (change === "command") candidate.identity.registrationManifest.commands = [{ name: "changed" }];
    if (change === "helper") candidate.identity.registrationManifest.loaderHelperApi++;
    if (change === "loader") candidate.identity.requiredLoaderProtocol = 2;
    if (change === "launcher") candidate.identity.requiredLauncherProtocol = 2;
    if (change === "skills" || change === "agents") candidate.identity.registrationManifest.resources = { [`${change}/example`]: "changed" };
    candidate.identity.registrationManifestHash = registrationHash(candidate.identity.registrationManifest);
    h.setCandidate(candidate); await h.loader.check(h.context);
    assert.deepEqual(h.counts(), { observers: 1, leases: 1, released: 0, imports: 2 });
    assert.match(h.notices.join(), /restart OMP/);
  });
}

test("new ID with identical metadata reloads, including an engine-only release", async t => {
  const h = harness(); t.after(() => h.loader.dispose());
  await h.loader.initialize(); await h.host.emit("session_start", h.context);
  h.setCandidate(selection(2)); await h.loader.check(h.context);
  assert.equal(h.counts().leases, 2);
  assert.equal(h.counts().observers, 1);
});

test("constructed metadata must equal declared manifest before publication", async t => {
  const h = harness(); t.after(() => h.loader.dispose());
  await h.loader.initialize(); await h.host.emit("session_start", h.context);
  h.assign(2, api => { (api as typeof h.host).registerCommand("undeclared", { description: "unexpected", handler: () => {} }); });
  h.setCandidate(selection(2)); await h.loader.check(h.context);
  assert.equal(h.host.commands.size, 0);
  assert.equal(h.counts().observers, 1);
  assert.match(h.notices.join(), /Constructed registrations/);
});
