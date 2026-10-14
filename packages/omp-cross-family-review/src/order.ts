export interface Model {
  provider: string;
  id: string;
}

export interface Models {
  current(): Model | undefined;
  resolve(spec: string): Model | undefined;
  family(model: Model): string;
}

export interface ReviewModels {
  model: string[];
  note: string;
}

export function orderReviewModels(
  patterns: readonly string[],
  fallbackRoles: readonly string[],
  models: Models,
): ReviewModels | undefined {
  const parent = models.current();
  const primary = patterns[0];
  if (!parent || primary === undefined) return undefined;
  const primaryModel = models.resolve(primary);
  if (!primaryModel) return undefined;

  const parentFamily = models.family(parent);
  const primaryCross = models.family(primaryModel) !== parentFamily;
  const seen = new Map<string, Set<string>>();
  seen.set(primaryModel.provider, new Set([primaryModel.id]));
  const cross: string[] = [];
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
    (models.family(candidate) !== parentFamily ? cross : same).push(spec);
  };
  for (let i = 1; i < patterns.length; i++) collect(patterns[i]!);
  for (const role of fallbackRoles) collect(role);

  const swapped = !primaryCross && cross.length > 0;
  const model = primaryCross
    ? [primary, ...cross, ...same]
    : swapped
      ? [...cross, primary, ...same]
      : [primary, ...same];
  const note = `fallback cross-family vs ${parent.provider}/${parent.id}${
    swapped ? "; primary swapped because it shares the parent's family" : ""
  }`;
  return { model, note };
}
