import { globSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { GuardContext, TargetResolver } from "./guard.ts";
import { unwrapTarget } from "./guard.ts";

/** The native adapter supplies OMP's own normalizers, never a second URI mapping. */
export interface HostPaths {
  resolve(target: string, context: GuardContext): Promise<string | undefined>;
  split(target: string, cwd: string): Promise<{ basePath: string; glob?: string }>;
  entries(targets: string[], cwd: string): Promise<string[]>;
}

export function createTargetResolver(host: HostPaths): TargetResolver {
  return {
    resolve: (target, context) => host.resolve(unwrapTarget(target), context),
    async expand(target, context) {
      const files = new Set<string>();
      for (const entry of await host.entries([target], context.cwd)) {
        const parsed = await host.split(entry, context.cwd);
        const base = await host.resolve(parsed.basePath, context);
        if (base === undefined) throw new Error("AST destination has no filesystem backing");
        const stat = statSync(base);
        if (!stat.isDirectory()) {
          if (!stat.isFile()) throw new Error(`not a regular file: ${base}`);
          files.add(base);
          continue;
        }
        // Native rewrites walk recursively; a bare glob matches basenames at any depth.
        const pattern = parsed.glob && !parsed.glob.includes("/") ? `**/${parsed.glob}` : parsed.glob ?? "**/*";
        for (const file of globSync(pattern, { cwd: base, exclude: [".git", "**/.git", "**/.git/**"] })) {
          const absolute = resolve(base, file);
          if (statSync(absolute).isFile()) files.add(absolute);
        }
      }
      return [...files];
    },
  };
}
