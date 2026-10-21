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
): ReviewModels {
  const excludedFamilies = new Set(excluded.map(({ model }) => models.family(model)));
  const candidates = [...patterns, ...fallbackRoles].map(spec => {
    const model = models.resolve(spec);
    const family = model ? models.family(model) : undefined;
    return {
      spec,
      model: model ? { provider: model.provider, id: model.id } : undefined,
      family,
      cause: !model ? "unavailable" : !family ? "unresolved family"
        : excludedFamilies.has(family) ? "excluded family" : "eligible",
    };
  });
  const diagnostics = `excluded families ${JSON.stringify([...excludedFamilies])}; candidates ${JSON.stringify(candidates)}; an available model with a resolved family outside the excluded families is required`;
  if (excluded.length === 0 || [...excludedFamilies].some(family => !family)) {
    return {
      block: true,
      reason: `CROSS_FAMILY_INDETERMINATE: family reference unresolved; family cannot be verified; ${diagnostics}`,
    };
  }
  const seen = new Map<string, Set<string>>();
  const model: string[] = [];
  for (const candidate of candidates) {
    if (candidate.cause !== "eligible" || !candidate.model) continue;
    let ids = seen.get(candidate.model.provider);
    if (ids?.has(candidate.model.id)) continue;
    if (!ids) {
      ids = new Set();
      seen.set(candidate.model.provider, ids);
    }
    ids.add(candidate.model.id);
    model.push(candidate.spec);
  }
  if (model.length === 0) {
    return { block: true, reason: `CROSS_FAMILY_EXHAUSTED: ${diagnostics}` };
  }
  return { model, note: "strict cross-family eligibility; effective transcript identity must pass the publication gate" };
}
