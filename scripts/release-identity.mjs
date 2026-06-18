import { execFileSync } from "node:child_process";

export const BUILD_ID = /^r(0|[1-9]\d*)$/;
export function idFromCount(count) {
  const text = String(count).trim();
  if (!/^(0|[1-9]\d*)$/.test(text)) throw new Error("Invalid first-parent commit count");
  return `r${text}`;
}
export function gitBuildIdentity(cwd, sha = "HEAD") {
  const git = args => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  if (git(["rev-parse", "--is-shallow-repository"]) !== "false") throw new Error("Build IDs require full history (fetch-depth: 0)");
  const commit = git(["rev-parse", "--verify", `${sha}^{commit}`]);
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Build identity requires a full SHA");
  return { version: idFromCount(git(["rev-list", "--count", "--first-parent", commit])), commit };
}
/** Pure decision boundary shared by the publisher and its no-spawn acceptance tests. */
export function publicationPlan({ validated, headSha, checkoutSha, version, tagSha, lastSha, firstParent, changed, exists }) {
  if (!validated) return false;
  if (!/^[a-f0-9]{40}$/.test(headSha) || checkoutSha !== headSha) throw new Error("Publication checkout is not the validated head_sha");
  if (!BUILD_ID.test(version)) throw new Error("Invalid release build ID");
  if (tagSha && tagSha !== headSha) throw new Error(`ID/SHA conflict for a4s-${version}`);
  if (lastSha && !firstParent) throw new Error("Validated SHA is not a first-parent descendant of the last published build");
  return Boolean(exists || changed);
}
export function assertPublishedDigest(archive, rebuilt, published) {
  if (!/^[a-f0-9]{64}$/.test(rebuilt) || rebuilt !== published) throw new Error(`Rerun digest mismatch for ${archive}; published artifacts are never overwritten`);
}
