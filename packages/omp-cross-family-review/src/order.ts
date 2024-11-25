export interface Model {
  provider: string;
  id: string;
}

export interface Models {
  current(): Model | undefined;
  resolve(spec: string): Model | undefined;
  family(model: Model): string;
}

export interface FamilyReference {
  label?: string;
  model: Model;
}

export interface ReviewModels {
  model?: string[];
  note?: string;
  block?: true;
  reason?: string;
}

export function orderReviewModels(
  patterns: readonly string[],
  fallbackRoles: readonly string[],
  models: Models,
  excluded: readonly FamilyReference[],
  strict = false,
): ReviewModels | undefined {
  const primary = patterns[0];
  if (strict && (excluded.length === 0 || primary === undefined)) {
    return { block: true, reason: "CROSS_FAMILY_INDETERMINATE: missing family reference or model candidates" };
  }
  if (excluded.length === 0 || primary === undefined) return undefined;
  const primaryModel = models.resolve(primary);
  if (!primaryModel && !strict) return undefined;

  const excludedFamilies = new Set(
    excluded.map(({ model }) => models.family(model)),
  );
  if (strict && [...excludedFamilies].some(family => !family)) {
    return { block: true, reason: "CROSS_FAMILY_INDETERMINATE: unresolved excluded family" };
  }
  const primaryQualifies = !!primaryModel && !!models.family(primaryModel) && !excludedFamilies.has(models.family(primaryModel));
  const seen = new Map<string, Set<string>>();
  if (primaryModel) seen.set(primaryModel.provider, new Set([primaryModel.id]));
  const qualifying: string[] = [];
  const same: string[] = [];
  const collect = (spec: string): void => {
    const candidate = models.resolve(spec);
    if (!candidate) return;
    let ids = seen.get(candidate.provider);
    if (ids?.has(candidate.id)) return;
    if (!ids) {
      ids = new Set();
      seen.set(candidate.provider, ids);
    }
    ids.add(candidate.id);
    const family = models.family(candidate);
    if (!family && strict) return;
    (excludedFamilies.has(family) ? same : qualifying).push(spec);
  };
  for (let i = 1; i < patterns.length; i++) collect(patterns[i]!);
  for (const role of fallbackRoles) collect(role);
  if (strict) {
    const model = [...(primaryQualifies ? [primary] : []), ...qualifying];
    if (model.length === 0) return {
      block: true,
      reason: `CROSS_FAMILY_EXHAUSTED: attempted ${[...patterns, ...fallbackRoles].join(", ")}; excluded families ${[...excludedFamilies].join(", ")}; no eligible model; resolutions ${JSON.stringify([...patterns, ...fallbackRoles].map(spec => {
        const candidate = models.resolve(spec);
        return { spec, model: candidate, family: candidate ? models.family(candidate) : undefined, cause: candidate ? "excluded or indeterminate family" : "unavailable" };
      }))}`,
    };
    return { model, note: "strict cross-family eligibility; effective transcript identity must pass the publication gate" };
  }

  const swapped = !primaryQualifies && qualifying.length > 0;
  const model = primaryQualifies
    ? [primary, ...qualifying, ...same]
    : swapped
      ? [...qualifying, primary, ...same]
      : [primary, ...same];
  const references = excluded.map(({ label, model: reference }) =>
    `${label ? `${label} ` : ""}${reference.provider}/${reference.id}`
  ).join(" and ");
  const note = `fallback cross-family vs ${references}${
    swapped ? "; primary swapped because it shares an excluded family" : ""
  }`;
  return { model, note };
}
