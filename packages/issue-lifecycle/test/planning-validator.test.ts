import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validatePlanningUnits, validatePlanningUnitsCommand } from "../src/planning-validator.ts";

function unit(id = "change", dag = "feature"): Record<string, unknown> {
  return { id, title: "Deliver result", dag, labels: [], ...(dag === "poc" ? { question: "Does the real target support this?" } : {}),
    body: dag === "poc" ? "## PoC\nQuestion\n## Verdict\nEvidence\n## After PASS\nDelivery" : "## Problem\nProblem\n## Change\nScope\n## Acceptance\nRun npm test" };
}
function validate(...rows: unknown[]) { return validatePlanningUnits(rows.map(row => JSON.stringify(row)).join("\n") + "\n"); }
const ref = (kind: string, target: unknown) => ({ kind, target });

test("all independent diagnostics include serializable expected/observed and deterministic line/field/rule order", () => {
  const input = JSON.stringify({ id: "Bad ID", title: " ", dag: "feature", labels: [7], body: "## Problem\nIncomplete" }) + '\n{invalid}\n' + JSON.stringify({ id: "third", dag: "poc", labels: [], body: null }) + "\n";
  const findings = validatePlanningUnits(input);
  assert.deepEqual(findings.map(({ line, field, rule }) => [line, field, rule]), [
    [1, "body", "required-sections"], [1, "id", "kebab-id"], [1, "labels[0]", "labels"], [1, "title", "title"],
    [2, "$", "json-object"], [3, "body", "body"], [3, "question", "poc-question"], [3, "title", "title"],
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(findings)), findings);
  assert.deepEqual(findings.find(row => row.field === "question")?.observed, { missing: true });
  assert.deepEqual(validatePlanningUnits(input), findings);
  assert.equal(validatePlanningUnits("")[0]?.rule, "required-units");
  for (const value of [null, [], 1, "unit", true]) assert.deepEqual(validate(value).map(row => row.rule), ["json-object"]);
  assert.deepEqual(validate({ ...unit(), findings: ["f1", 7, "f1"], revision: { issue: 444, fields: ["title", "unknown", "title"] } }).map(row => [row.field, row.rule]), [
    ["findings", "unique-findings"], ["findings[1]", "findings"], ["revision.fields", "revision-unique-fields"], ["revision.fields[1]", "revision-field"],
  ]);
});

test("native fields preserve feature/PoC sections, Spanish alternatives and provenance rules", () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ ...unit(), id: "Bad ID" }, "kebab-id"], [{ ...unit(), id: null }, "kebab-id"],
    [{ ...unit(), title: " " }, "title"], [{ ...unit(), title: 7 }, "title"], [{ ...unit(), dag: "other" }, "dag"],
    [{ ...unit("probe", "poc"), question: undefined }, "poc-question"], [{ ...unit(), extra: [] }, "unit-fields"],
    [{ ...unit(), relationships: {} }, "relationships"], [{ ...unit(), body: "## Problem\nIncomplete" }, "required-sections"],
    [{ ...unit("probe", "poc"), body: "## PoC\nIncomplete" }, "required-sections"], [{ ...unit(), body: null }, "body"],
    [{ ...unit(), labels: "change" }, "labels"], [{ ...unit(), labels: [7] }, "labels"],
    [{ ...unit(), source: "unknown" }, "source"], [{ ...unit(), source: null }, "source"],
    [{ ...unit(), findings: "f1" }, "findings"], [{ ...unit(), findings: [""] }, "findings"],
    [{ ...unit(), findings: [7] }, "findings"], [{ ...unit(), findings: ["f1", "f1"] }, "unique-findings"],
  ];
  for (const [row, rule] of cases) assert.ok(validate(unit("first"), row).some(finding => finding.line === 2 && finding.rule === rule), JSON.stringify(row));
  assert.deepEqual(validate(unit(), unit()).map(row => [row.line, row.rule]), [[2, "unique-id"]]);
  for (const source of ["refine", "discovery", "plan"]) assert.deepEqual(validate({ ...unit(), source, findings: ["f1"] }, unit("probe", "poc")), []);
  assert.deepEqual(validate({ ...unit(), body: "## Problema\nProblem\n## Cambio\nScope\n## Aceptación\nTest" },
    { ...unit("probe", "poc"), body: "## PoC\nQuestion\n## Veredicto\nEvidence\n## Después del PASS\nScope" }), []);
  assert.deepEqual(validate({ ...unit(), body: 7, dag: null, relationships: null }).map(row => row.rule), ["body", "dag", "relationships"]);
});

test("typed references diagnose malformed, unknown, duplicate, ambiguous and cyclic edges independently", () => {
  const cases: Array<[unknown[], string]> = [
    [[null], "relationship-object"], [[{ kind: "parent" }], "relationship-fields"],
    [[{ ...ref("parent", { issue: 442 }), extra: true }], "relationship-fields"], [[ref("blocks", { issue: 442 })], "relationship-kind"],
    [[ref("parent", null)], "relationship-target"], [[ref("parent", {})], "relationship-target"],
    [[ref("parent", { unit: "first", issue: 442 })], "relationship-target"], [[ref("parent", { unit: 442 })], "relationship-unit"],
    [[ref("parent", { unit: "Bad ID" })], "relationship-unit"], [[ref("parent", { unit: "unknown" })], "relationship-unknown-unit"],
    [[ref("parent", { unit: "consumer" })], "relationship-self"],
    ...[0, -1, 1.5, "442", null, 9007199254740992].map(issue => [[ref("blocked_by", { issue })], "relationship-issue"] as [unknown[], string]),
    [[ref("blocked_by", { unit: "first" }), ref("blocked_by", { unit: "first" })], "relationship-duplicate"],
    [[ref("parent", { unit: "first" }), ref("parent", { issue: 442 })], "relationship-parent"],
  ];
  for (const [relationships, rule] of cases) assert.ok(validate(unit("first"), { ...unit("consumer"), relationships }).some(row => row.line === 2 && row.rule === rule), JSON.stringify(relationships));
  assert.ok(validate(unit("first"), unit("first"), { ...unit("consumer"), relationships: [ref("parent", { unit: "first" })] }).some(row => row.rule === "relationship-ambiguous-unit"));
  for (const kind of ["blocked_by", "parent"]) for (const length of [2, 3]) {
    const rows = Array.from({ length }, (_, index) => ({ ...unit(`node-${index}`), relationships: [ref(kind, { unit: `node-${(index + 1) % length}` })] }));
    assert.equal(validate(...rows).filter(row => row.rule === "relationship-cycle").length, length);
  }
  assert.deepEqual(validate({ ...unit("parent"), relationships: [ref("blocked_by", { unit: "child" })] }, { ...unit("child"), relationships: [ref("parent", { unit: "parent" })] }), []);
  assert.deepEqual(validate({ ...unit("consumer"), relationships: [ref("blocked_by", { unit: "later" })] }, { ...unit("later"), relationships: [] }), []);
  const independent = validate({ ...unit("a"), relationships: [null, ref("blocked_by", { unit: "b" })] }, { ...unit("b"), relationships: [ref("blocked_by", { unit: "a" })] });
  assert.equal(independent.filter(row => row.rule === "relationship-cycle").length, 2);
  assert.equal(independent.filter(row => row.rule === "relationship-object").length, 1);
  assert.deepEqual(validate({ ...unit(), revision: {}, relationships: [{}] }).map(row => row.rule), ["relationship-fields", "revision-fields"]);
  assert.deepEqual(validate({ ...unit(), relationships: [ref("unknown", null)] }).map(row => row.rule), ["relationship-kind", "relationship-target"]);
});

test("numeric targets share graph identity only with a unique well-formed revision binding", () => {
  const alpha = { ...unit("alpha"), revision: { issue: 7001, fields: [] } };
  const beta = { ...unit("beta"), revision: { issue: 7002, fields: [] } };
  assert.deepEqual(validate({ ...alpha, relationships: [ref("blocked_by", { issue: 7001 })] }).map(({ line, field, rule, observed }) => [line, field, rule, observed]),
    [[1, "relationships[0].target.issue", "relationship-self", 7001]]);
  for (const kind of ["blocked_by", "parent"]) {
    assert.deepEqual(validate({ ...alpha, relationships: [ref(kind, { issue: 7002 })] }, { ...beta, relationships: [ref(kind, { issue: 7001 })] })
      .map(({ line, field, rule, observed }) => [line, field, rule, observed]),
    [[1, "relationships[0].target.issue", "relationship-cycle", 7002], [2, "relationships[0].target.issue", "relationship-cycle", 7001]]);
  }
  assert.deepEqual(validate({ ...alpha, relationships: [ref("blocked_by", { unit: "beta" }), ref("blocked_by", { issue: 7002 })] }, beta)
    .map(({ line, field, rule, observed }) => [line, field, rule, observed]),
  [[1, "relationships[1].target.issue", "relationship-duplicate", 7002]]);
  assert.deepEqual(validate({ ...alpha, relationships: [ref("blocked_by", { issue: 7002 })] }, { ...beta, relationships: [ref("blocked_by", { unit: "alpha" })] })
    .map(({ line, field, rule }) => [line, field, rule]),
  [[1, "relationships[0].target.issue", "relationship-cycle"], [2, "relationships[0]", "relationship-cycle"]]);
  assert.deepEqual(validate({ ...alpha, relationships: [ref("blocked_by", { issue: 7002 }), ref("blocked_by", { issue: 9999 })] },
    { ...beta, relationships: [ref("parent", { issue: 7001 })] }), []);
  assert.deepEqual(validate({ ...alpha, relationships: [ref("blocked_by", { issue: 7001 })] }, { ...beta, revision: alpha.revision })
    .map(({ line, rule }) => [line, rule]), [[1, "revision-unique-issue"], [2, "revision-unique-issue"]]);
  assert.deepEqual(validate({ ...alpha, revision: { issue: 7001, fields: ["question"] }, relationships: [ref("blocked_by", { issue: 7001 })] })
    .map(row => row.rule), ["revision-field"]);
  assert.deepEqual(validate({ ...alpha, relationships: [ref("blocked_by", { issue: 7001 })] }, { ...beta, id: "alpha" })
    .map(row => row.rule), ["unique-id"]);
});

test("revision declares exact existing identity and unique explicit fields, including binding only", () => {
  for (const fields of [[], ["title"], ["body", "labels"], ["title", "body", "labels"]]) assert.deepEqual(validate({ ...unit(), revision: { issue: 444, fields } }), []);
  const cases: Array<[unknown, string]> = [
    [null, "revision-object"], [{ issue: 444 }, "revision-fields"], [{ issue: 444, fields: [], extra: true }, "revision-fields"],
    [{ issue: 444, fields: "title" }, "revision-field-list"], [{ issue: 444, fields: ["question"] }, "revision-field"],
    [{ issue: 444, fields: ["title", "title"] }, "revision-unique-fields"],
    ...[0, -1, 1.5, "444", null, 9007199254740992].map(issue => [{ issue, fields: [] }, "revision-issue"] as [unknown, string]),
  ];
  for (const [revision, rule] of cases) assert.ok(validate({ ...unit(), revision }).some(row => row.rule === rule), JSON.stringify(revision));
  assert.deepEqual(validate({ ...unit("first"), revision: { issue: 444, fields: [] } }, { ...unit("second"), revision: { issue: 444, fields: ["title"] } }).map(row => [row.line, row.rule]), [[1, "revision-unique-issue"], [2, "revision-unique-issue"]]);
});

test("existing package CLI snapshots exact canonical bytes only when valid and emits the complete findings surface", () => {
  const root = mkdtempSync(join(tmpdir(), "planning-validator-"));
  const input = join(root, "units.jsonl"), snapshot = join(root, "snapshot.jsonl"), findings = join(root, "findings.md");
  const run = (...args: string[]) => {
    let stderr = "";
    const write = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    }) as typeof process.stderr.write;
    try { return { status: validatePlanningUnitsCommand(args), stderr }; }
    finally { process.stderr.write = write; }
  };
  try {
    const canonical = "  " + JSON.stringify(unit()) + "\r\n" + JSON.stringify(unit("second"));
    writeFileSync(input, canonical);
    const valid = run("--input", input, "--snapshot", snapshot, "--findings", findings);
    assert.equal(valid.status, 0, valid.stderr);
    assert.deepEqual(readFileSync(snapshot), readFileSync(input));
    assert.equal(readFileSync(findings, "utf8"), "");
    writeFileSync(input, '{invalid}\n' + JSON.stringify({ ...unit(), title: null, body: null }) + "\n");
    const invalid = run("--input", input, "--snapshot", snapshot, "--findings", findings);
    assert.equal(invalid.status, 1);
    assert.deepEqual(invalid.stderr.trim().split("\n").map(line => JSON.parse(line)), validatePlanningUnits(readFileSync(input, "utf8")));
    assert.equal(readFileSync(findings, "utf8"), invalid.stderr);
    assert.equal(existsSync(snapshot), false);
    const original = readFileSync(input);
    for (const args of [[], ["--input", "relative.jsonl"], ["--input", input, "--input", input], ["--input", input, "--unknown", snapshot], ["--input", input, "--findings", input], ["--input", input, "--snapshot", input]]) {
      const result = run(...args);
      assert.equal(result.status, 1);
      assert.equal(JSON.parse(result.stderr).rule, "validator-input");
      assert.deepEqual(readFileSync(input), original);
    }
    writeFileSync(input, Buffer.from([0xff]));
    const encoding = run("--input", input, "--snapshot", snapshot, "--findings", findings);
    assert.equal(encoding.status, 1);
    assert.equal(JSON.parse(encoding.stderr).rule, "validator-input");
    assert.equal(readFileSync(findings, "utf8"), encoding.stderr);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
