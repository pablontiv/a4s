import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/** The native planning input contract, shared by preparation and check_plan. */
export const planningUnitSchema = {
  fields: ["id", "title", "dag", "labels", "body", "question", "source", "findings", "relationships", "revision"],
  id: /^[a-z0-9]+(-[a-z0-9]+)*$/,
  dags: ["feature", "poc"],
  sources: ["refine", "discovery", "plan"],
  sections: {
    feature: ["(Problema|Problem)", "(Cambio|Change)", "(Aceptación|Acceptance)"],
    poc: ["PoC", "(Veredicto|Verdict)", "(Después del PASS|After PASS)"],
  },
  relationshipKinds: ["blocked_by", "parent"],
  revisionFields: ["title", "body", "labels"],
} as const;

export interface PlanningDiagnostic {
  line: number;
  field: string;
  rule: string;
  expected: unknown;
  observed: unknown;
  unit?: string;
}

type ObjectValue = Record<string, unknown>;
type Row = { line: number; value: ObjectValue };
type Edge = { row: Row; field: string; kind: string; target: { unit: string } | { issue: number }; observed: unknown };
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === "string" && /\S/.test(value);
const safeIssue = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const id = (value: unknown): value is string => typeof value === "string" && planningUnitSchema.id.test(value);
const member = (values: readonly string[], value: unknown): value is string => typeof value === "string" && values.includes(value);
const exactKeys = (value: ObjectValue, keys: string[]): boolean => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const missing = { missing: true };
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

/** Collect independent errors; graph checks consume only unambiguous, well-formed references. */
export function validatePlanningUnits(input: string): PlanningDiagnostic[] {
  const diagnostics: PlanningDiagnostic[] = [];
  const edges: Edge[] = [];
  const ids = new Map<string, Row[]>(), issues = new Map<number, Row[]>();
  const add = (row: Row, field: string, rule: string, expected: unknown, observed: unknown): void => {
    diagnostics.push({ line: row.line, field, rule, expected, observed: observed === undefined ? missing : observed,
      ...(typeof row.value.id === "string" ? { unit: row.value.id } : {}) });
  };
  const lines = input.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (!lines.length) add({ line: 1, value: {} }, "$", "required-units", "one or more JSONL units", input);
  for (const [index, line] of lines.entries()) {
    let value: unknown;
    try { value = JSON.parse(line); }
    catch { add({ line: index + 1, value: {} }, "$", "json-object", "one JSON object per line", line); continue; }
    const row = { line: index + 1, value: object(value) ? value : {} };
    if (!object(value)) { add(row, "$", "json-object", "one JSON object per line", value); continue; }
    for (const key of Object.keys(value)) {
      if (!member(planningUnitSchema.fields, key)) add(row, key, "unit-fields", planningUnitSchema.fields, value[key]);
    }
    if (!id(value.id)) add(row, "id", "kebab-id", "unique kebab-case ID", value.id);
    else { const matches = ids.get(value.id) ?? []; matches.push(row); ids.set(value.id, matches); }
    if (!nonempty(value.title)) add(row, "title", "title", "nonempty string", value.title);
    if (!member(planningUnitSchema.dags, value.dag)) add(row, "dag", "dag", planningUnitSchema.dags, value.dag);
    if (value.dag === "poc" && !nonempty(value.question)) add(row, "question", "poc-question", "nonempty string for PoC", value.question);
    for (const field of ["labels", "findings"] as const) {
      if (field === "findings" && !Object.hasOwn(value, field)) continue;
      const items = value[field];
      if (!Array.isArray(items)) add(row, field, field, "array of nonempty strings", items);
      else {
        items.forEach((item, index) => { if (!nonempty(item)) add(row, `${field}[${index}]`, field, "nonempty string", item); });
        if (field === "findings") {
          const validItems = items.filter(nonempty);
          if (new Set(validItems).size !== validItems.length) add(row, field, "unique-findings", "unique finding IDs", items);
        }
      }
    }
    if (Object.hasOwn(value, "source") && !member(planningUnitSchema.sources, value.source)) add(row, "source", "source", planningUnitSchema.sources, value.source);
    if (!nonempty(value.body)) add(row, "body", "body", "nonempty string", value.body);
    else if (value.dag === "feature" || value.dag === "poc") {
      const absent = planningUnitSchema.sections[value.dag].filter(section => !new RegExp(`^## ${section}[ \\t]*\\r?$`, "m").test(value.body as string));
      if (absent.length) add(row, "body", "required-sections", absent.map(section => `## ${section}`), value.body);
    }
    if (Object.hasOwn(value, "revision")) {
      const revision = value.revision;
      if (!object(revision)) add(row, "revision", "revision-object", { issue: "positive safe integer", fields: planningUnitSchema.revisionFields }, revision);
      else {
        if (!exactKeys(revision, ["issue", "fields"])) add(row, "revision", "revision-fields", ["issue", "fields"], Object.keys(revision).sort());
        if (Object.hasOwn(revision, "issue")) {
          if (!safeIssue(revision.issue)) add(row, "revision.issue", "revision-issue", "positive safe integer", revision.issue);
          else { const matches = issues.get(revision.issue) ?? []; matches.push(row); issues.set(revision.issue, matches); }
        }
        if (Object.hasOwn(revision, "fields") && !Array.isArray(revision.fields)) add(row, "revision.fields", "revision-field-list", "array of unique declared fields (empty binds identity only)", revision.fields);
        else if (Array.isArray(revision.fields)) {
          revision.fields.forEach((field, index) => { if (!member(planningUnitSchema.revisionFields, field)) add(row, `revision.fields[${index}]`, "revision-field", planningUnitSchema.revisionFields, field); });
          const validFields = revision.fields.filter(field => member(planningUnitSchema.revisionFields, field));
          if (new Set(validFields).size !== validFields.length) add(row, "revision.fields", "revision-unique-fields", "unique declared fields", revision.fields);
        }
      }
    }
    if (!Object.hasOwn(value, "relationships")) continue;
    if (!Array.isArray(value.relationships)) { add(row, "relationships", "relationships", "array of typed relationships", value.relationships); continue; }
    for (const [index, edge] of value.relationships.entries()) {
      const field = `relationships[${index}]`;
      if (!object(edge)) { add(row, field, "relationship-object", "object with kind and target", edge); continue; }
      if (!exactKeys(edge, ["kind", "target"])) add(row, field, "relationship-fields", ["kind", "target"], edge);
      const kindValid = member(planningUnitSchema.relationshipKinds, edge.kind);
      if (Object.hasOwn(edge, "kind") && !kindValid) add(row, field, "relationship-kind", planningUnitSchema.relationshipKinds, edge.kind);
      if (!Object.hasOwn(edge, "target")) continue;
      const target = edge.target;
      if (!object(target) || !(exactKeys(target, ["unit"]) || exactKeys(target, ["issue"]))) { add(row, field, "relationship-target", "exactly {unit: kebab-ID} or {issue: positive safe integer}", target); continue; }
      if (Object.hasOwn(target, "unit") && !id(target.unit)) { add(row, field, "relationship-unit", "kebab-case unit ID", target.unit); continue; }
      if (Object.hasOwn(target, "issue") && !safeIssue(target.issue)) { add(row, field, "relationship-issue", "positive safe integer", target.issue); continue; }
      if (kindValid && exactKeys(edge, ["kind", "target"])) edges.push({ row, field, kind: edge.kind as string, target: target as Edge["target"], observed: edge });
    }
  }
  for (const matches of ids.values()) for (const row of matches.slice(1)) add(row, "id", "unique-id", "unique unit ID", row.value.id);
  for (const [issue, matches] of issues) if (matches.length > 1) for (const row of matches) add(row, "revision.issue", "revision-unique-issue", "one unit per existing issue identity", issue);
  const graph: Edge[] = [];
  for (const edge of edges) {
    const { row, field, target, kind, observed } = edge;
    const sameRow = edges.filter(other => other.row === row);
    const previous = sameRow.slice(0, sameRow.indexOf(edge));
    if (previous.some(other => other.kind === kind && ("unit" in target ? "unit" in other.target && other.target.unit === target.unit : "issue" in other.target && other.target.issue === target.issue))) add(row, field, "relationship-duplicate", "one occurrence per kind/target", observed);
    if (kind === "parent" && sameRow.filter(other => other.kind === "parent").length > 1) add(row, field, "relationship-parent", "at most one parent", observed);
    if (!("unit" in target)) continue;
    const matches = ids.get(target.unit);
    if (!matches) add(row, field, "relationship-unknown-unit", "ID in this snapshot", target.unit);
    else if (matches.length !== 1) add(row, field, "relationship-ambiguous-unit", "unambiguous ID in this snapshot", target.unit);
    else if (target.unit === row.value.id) add(row, field, "relationship-self", "a different unit", target.unit);
    else if (id(row.value.id) && ids.get(row.value.id)?.length === 1) graph.push(edge);
  }
  const reaches = (kind: string, start: string, goal: string): boolean => {
    const pending = [start], seen = new Set<string>();
    while (pending.length) {
      const current = pending.pop()!;
      if (current === goal) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      for (const edge of graph) if (edge.kind === kind && edge.row.value.id === current && "unit" in edge.target) pending.push(edge.target.unit);
    }
    return false;
  };
  for (const edge of graph) if ("unit" in edge.target && reaches(edge.kind, edge.target.unit, edge.row.value.id as string)) add(edge.row, edge.field, "relationship-cycle", `acyclic ${edge.kind} unit graph`, edge.observed);
  return diagnostics.sort((a, b) => a.line - b.line || compare(a.field, b.field) || compare(a.rule, b.rule));
}

export function planningDiagnosticsText(diagnostics: PlanningDiagnostic[]): string {
  return diagnostics.map(diagnostic => JSON.stringify(diagnostic) + "\n").join("");
}

/** Existing package CLI entry point; reads once and snapshots those exact validated bytes. */
export function validatePlanningUnitsCommand(args: string[]): number {
  const options = new Map<string, string>();
  try {
    for (let index = 0; index < args.length; index += 2) {
      const flag = args[index], value = args[index + 1];
      if (!["--input", "--snapshot", "--findings"].includes(flag!) || !value || options.has(flag!)) throw new Error("Usage: validate-planning-units --input <absolute-file> [--snapshot <file>] [--findings <file>]");
      options.set(flag!, value);
    }
    const input = options.get("--input");
    if (!input || !isAbsolute(input)) throw new Error("--input requires an absolute file path");
    const paths = [...options.values()].map(path => resolve(path));
    if (new Set(paths).size !== paths.length) throw new Error("Input, snapshot and findings must have distinct paths");
    const snapshot = options.get("--snapshot"), findings = options.get("--findings");
    if (snapshot) rmSync(snapshot, { force: true });
    const bytes = readFileSync(input);
    const diagnostics = validatePlanningUnits(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const text = planningDiagnosticsText(diagnostics);
    if (findings) writeFileSync(findings, text);
    if (text) process.stderr.write(text);
    if (diagnostics.length) return 1;
    if (snapshot) writeFileSync(snapshot, bytes);
    return 0;
  } catch (error) {
    const text = planningDiagnosticsText([{ line: 1, field: "$input", rule: "validator-input", expected: "readable canonical JSONL input and writable distinct output paths", observed: error instanceof Error ? error.message : String(error) }]);
    const findings = options.get("--findings");
    if (findings && ![options.get("--input"), options.get("--snapshot")].some(path => path && resolve(path) === resolve(findings))) {
      try { writeFileSync(findings, text); } catch { /* stderr remains authoritative when the findings destination is unwritable. */ }
    }
    process.stderr.write(text);
    return 1;
  }
}
