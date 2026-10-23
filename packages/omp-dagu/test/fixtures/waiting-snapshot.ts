import { parse, stringify } from "yaml";

/** Model admitted cancellation-capable human-task snapshots predating native role jobs. */
export function waitingSnapshot(template: string): string {
  const source = parse(template);
  const gate = source.steps.find((step: { id: string }) => step.id === "start_primary_unavailable_cancellation");
  for (const [id, fields] of [
    ["triage", ["POC", "QUESTION", "BASIS"]],
    ["implement", ["SUMMARY", "MESSAGE", "IMPLEMENTER"]],
    ["quality_review", ["QA", "REVIEW"]],
  ] as const) {
    const index = source.steps.findIndex((step: { id: string }) => step.id === id);
    const original = source.steps[index];
    source.steps[index] = {
      id, depends: original.depends, preconditions: original.preconditions,
      action: "human.task", with: { prompt: `Historical ${id} checkpoint`, form: {
        type: "object", properties: { CANCEL: { type: "string", enum: ["yes", "no"] },
          ...Object.fromEntries(fields.map(field => [field, { type: "string", minLength: 1 }])) },
      } },
    };
    for (const step of source.steps) if (step.depends === id) step.depends = `${id}_cancellation`;
    source.steps.splice(index + 1, 0, {
      id: `${id}_cancellation`, depends: id, preconditions: original.preconditions,
      env: [{ CANCEL: `\${steps.${id}.outputs.CANCEL}` }, { CHECKPOINT: id }, { REQUIRED_FIELDS: fields.join(" ") },
        ...fields.map(field => ({ [field]: `\${steps.${id}.outputs.${field}}` }))], run: gate.run,
    });
  }
  return stringify(source);
}
