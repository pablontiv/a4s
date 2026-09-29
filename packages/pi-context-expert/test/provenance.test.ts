import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const thirdParty = new URL("../third_party/compact-adviser/", import.meta.url);

test("compact-adviser provenance pins the audited MIT source with no automatic synchronization", async () => {
  const [license, provenance] = await Promise.all([
    readFile(new URL("LICENSE", thirdParty), "utf8"),
    readFile(new URL("PROVENANCE.md", thirdParty), "utf8"),
  ]);
  assert.match(license, /^MIT License/m);
  assert.match(provenance, /2e5f982e70fbce348287a25b8333970e6ed3aef7/);
  assert.match(provenance, /sin sincronización automática/);
  assert.match(provenance, /Imported files:[\s\S]*LICENSE/);
});
