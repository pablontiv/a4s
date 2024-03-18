import { statSync } from "node:fs";
import primaryGuard from "./index.ts";
import { createTargetResolver } from "./paths.ts";
import type { GuardContext, TargetResolver } from "./guard.ts";

// OMP-only modules cannot be statically imported by non-host consumers/tests.
// Literal external imports let the compiled host bind its own implementations.
async function hostResolver(): Promise<TargetResolver> {
  const [plan, paths, urls, archives, sqlite, conflicts] = await Promise.all([
    import("@oh-my-pi/pi-coding-agent/tools/plan-mode-guard"),
    import("@oh-my-pi/pi-coding-agent/tools/path-utils"),
    import("@oh-my-pi/pi-coding-agent/internal-urls"),
    import("@oh-my-pi/pi-utils/ar"),
    import("@oh-my-pi/pi-coding-agent/tools/sqlite-reader"),
    import("@oh-my-pi/pi-coding-agent/tools/conflict-detect"),
  ]);
  async function resolve(target: string, context: GuardContext): Promise<string | undefined> {
    const router = urls.InternalUrlRouter.instance();
    const path = conflicts.recoverConflictUriPrefix(router.peelWriteSelector(target, "write")).path;
    const routed = router.writeTarget(path);
    const policy = routed?.spec.write;
    // These host policies explicitly promise no filesystem mutation (e.g. peer messages).
    if (policy?.scope === "coordination" || policy?.scope === "reply" || (routed && policy?.cancels?.(routed.url))) return;
    // Archive/SQLite members mutate their container, including when that container is a symlink.
    for (const candidates of [
      archives.parseArchivePathCandidates(path).map(candidate => candidate.archivePath),
      sqlite.parseSqlitePathCandidates(path).map(candidate => candidate.sqlitePath),
    ]) {
      const containers = candidates.filter(candidate => candidate !== path);
      for (const container of containers) {
        const absolute = await plan.resolvePlanPath(context, container);
        try { if (statSync(absolute).isFile()) return absolute; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      if (containers[0]) return plan.resolvePlanPath(context, containers[0]);
    }
    return plan.resolvePlanPath(context, path);
  }
  return createTargetResolver({ resolve, split: paths.parseSearchPathPreferringLiteral, entries: paths.expandDelimitedPathEntries });
}

export default function nativePrimaryGuard(pi: Parameters<typeof primaryGuard>[0]): void {
  // Defer host imports until a covered call; unsupported hosts fail closed on writes.
  let resolver: Promise<TargetResolver> | undefined;
  primaryGuard(pi, () => resolver ??= hostResolver());
}
