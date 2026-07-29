import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export type IssueTitleResolver = (issue: string, signal: AbortSignal) => Promise<string>;

export function issueSlug(title: string): string | undefined {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
  return slug || undefined;
}

export function ghIssueTitleResolver(cwd: string): IssueTitleResolver {
  return async (issue, signal) =>
    (await exec("gh", ["issue", "view", issue, "--json", "title", "--jq", ".title"], {
      cwd,
      timeout: 5000,
      signal,
    })).stdout.trim();
}

export class IssueTitles {
  private readonly cached = new Map<string, string | undefined>();
  private readonly inFlight = new Map<string, Promise<boolean>>();

  private readonly resolver: IssueTitleResolver;
  constructor(resolver: IssueTitleResolver) { this.resolver = resolver; }

  has(issue: string): boolean {
    return this.cached.has(issue);
  }

  get(issue: string): string | undefined {
    return this.cached.get(issue);
  }

  load(issue: string, signal: AbortSignal): Promise<boolean> {
    if (this.cached.has(issue)) return Promise.resolve(true);
    const pending = this.inFlight.get(issue);
    if (pending) return pending;

    const lookup = Promise.resolve()
      .then(() => this.resolver(issue, signal))
      .then(title => {
        this.cached.set(issue, issueSlug(title));
        return true;
      })
      .catch(() => false)
      .finally(() => this.inFlight.delete(issue));
    this.inFlight.set(issue, lookup);
    return lookup;
  }
}
