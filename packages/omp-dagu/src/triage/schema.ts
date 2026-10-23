export const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    poc: { type: "string", enum: ["yes", "no"] },
    behavior: { type: "string", minLength: 1, pattern: "\\S" },
    question: { type: "string", minLength: 1, pattern: "\\S" },
    reason: { type: "string", minLength: 1, pattern: "\\S" },
    requiredTargets: { type: "array", items: { type: "string", minLength: 1 } },
    authorizedTargets: { type: "array", items: { type: "string", minLength: 1 } },
    scopeBasis: { type: "string", minLength: 1, pattern: "\\S" },
  },
  required: ["poc", "behavior", "question", "reason"],
  additionalProperties: false,
} as const;

const NONEMPTY_TEXT = new RegExp(REVIEW_SCHEMA.properties.behavior.pattern);

export interface ReviewDecision {
  poc: "yes" | "no"; behavior: string; question: string; reason: string;
  requiredTargets?: string[]; authorizedTargets?: string[]; scopeBasis?: string;
}

function invalid(field: string, expected: string, observed: unknown): never {
  throw new Error(`TRIAGE_REVIEW_INVALID: field=${field} expected=${expected} observed=${observed === undefined ? "<missing>" : JSON.stringify(observed)}`);
}

export function parseReview(output: unknown): ReviewDecision {
  if (typeof output !== "string") invalid("$", "JSON object", output);
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    // Native results may surround a JSON line with reviewer prose.
    let parsed = false;
    for (const line of output.split("\n")) {
      try { value = JSON.parse(line); parsed = true; break; }
      catch { /* Try the next result line. */ }
    }
    if (!parsed) invalid("$", "JSON object", output);
  }
  if (value === null || typeof value !== REVIEW_SCHEMA.type || Array.isArray(value)) invalid("$", REVIEW_SCHEMA.type, value);
  const object = value as Record<string, unknown>;
  for (const field of REVIEW_SCHEMA.required) {
    const rule = REVIEW_SCHEMA.properties[field];
    const observed = object[field];
    if (typeof observed !== rule.type) invalid(field, rule.type, observed);
    if ("enum" in rule && !rule.enum.some(item => item === observed)) invalid(field, JSON.stringify(rule.enum), observed);
    if ("minLength" in rule && ((observed as string).length < rule.minLength || !NONEMPTY_TEXT.test(observed as string))) invalid(field, "nonempty string", observed);
  }
  if (object.poc === "yes") {
    for (const field of ["requiredTargets", "authorizedTargets"] as const) {
      const targets = object[field];
      if (!Array.isArray(targets) || targets.some(target => typeof target !== "string" || !target.trim())) invalid(field, "JSON string array", targets);
    }
    if (typeof object.scopeBasis !== "string" || !object.scopeBasis.trim()) invalid("scopeBasis", "authorization evidence", object.scopeBasis);
  }
  for (const field of Object.keys(object)) {
    if (!Object.hasOwn(REVIEW_SCHEMA.properties, field)) invalid(field, "additionalProperties=false", object[field]);
  }
  return object as unknown as ReviewDecision;
}
