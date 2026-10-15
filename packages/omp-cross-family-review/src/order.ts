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
  model: string[];
  note: string;
}

export function orderReviewModels(
  patterns: readonly string[],
  fallbackRoles: readonly string[],
  models: Models,
  excluded: readonly FamilyReference[],
): ReviewModels | undefined {
  const primary = patterns[0];
  if (excluded.length === 0 || primary === undefined) return undefined;
  const primaryModel = models.resolve(primary);
  if (!primaryModel) return undefined;

  const excludedFamilies = new Set(
    excluded.map(({ model }) => models.family(model)),
  );
  const primaryQualifies = !excludedFamilies.has(models.family(primaryModel));
  const seen = new Map<string, Set<string>>();
  seen.set(primaryModel.provider, new Set([primaryModel.id]));
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
    (
      excludedFamilies.has(models.family(candidate)) ? same : qualifying
    ).push(spec);
  };
  for (let i = 1; i < patterns.length; i++) collect(patterns[i]!);
  for (const role of fallbackRoles) collect(role);

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
