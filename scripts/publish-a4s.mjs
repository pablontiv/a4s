import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, readFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gitBuildIdentity, publicationPlan, assertPublishedDigest } from "./release-identity.mjs";

const defaultGithub = args => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
export function planPublication({ cwd, event, inputs, gh = defaultGithub }) {
  const run = event.workflow_run;
  if (!run || run.conclusion !== "success" || run.event !== "push" || run.head_branch !== "main" ||
      run.head_repository?.full_name !== event.repository?.full_name) return { publish: false };
  const repository = event.repository.full_name;
  const pages = JSON.parse(gh(["api", "--paginate", "--slurp", `repos/${repository}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`]));
  if (!Array.isArray(pages) || !pages.length || pages.some(page => !Array.isArray(page.jobs))) throw new Error("Invalid validated workflow jobs");
  const validation = pages.flatMap(page => page.jobs).filter(job => job.name === "validate");
  if (validation.length !== 1 || validation[0].conclusion !== "success" || validation[0].head_sha !== run.head_sha) return { publish: false };
  const build = gitBuildIdentity(cwd);
  const releasePages = JSON.parse(gh(["api", "--paginate", "--slurp", `repos/${repository}/releases?per_page=100`]));
  if (!Array.isArray(releasePages) || releasePages.some(page => !Array.isArray(page))) throw new Error("Invalid release inventory");
  const releases = releasePages.flat();
  const tag = `a4s-${build.version}`;
  const existing = releases.find(release => release.tag_name === tag);
  if (existing && (existing.draft !== false || existing.prerelease !== false)) throw new Error(`Unavailable immutable release ${tag}`);
  const published = releases.filter(release => release.draft === false && release.prerelease === false);
  const builds = published.filter(release => /^a4s-r(0|[1-9]\d*)$/.test(release.tag_name)).sort((a, b) => {
    const left = BigInt(a.tag_name.slice(5)), right = BigInt(b.tag_name.slice(5));
    return left === right ? 0 : left > right ? -1 : 1;
  });
  const last = builds[0] ?? published.filter(release => /^v\d+\.\d+\.\d+$/.test(release.tag_name)).sort((a, b) => String(b.published_at).localeCompare(String(a.published_at)))[0];
  const git = args => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const commitFor = name => git(["rev-parse", "--verify", `refs/tags/${name}^{commit}`]);
  const tagRef = spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/tags/${tag}`], { cwd });
  if (tagRef.error || ![0, 1].includes(tagRef.status)) throw new Error(`Cannot inspect release tag ${tag}`);
  const tagSha = tagRef.status === 0 ? commitFor(tag) : undefined;
  if (existing && !tagSha) throw new Error(`Published release is missing its tag ${tag}`);
  const lastSha = last ? commitFor(last.tag_name) : undefined;
  const firstParent = !lastSha || git(["rev-list", "--first-parent", build.commit]).split("\n").includes(lastSha);
  if (!Array.isArray(inputs) || !inputs.length || inputs.some(input => typeof input !== "string" || !input)) throw new Error("Missing shipped-input inventory");
  const changed = !lastSha || git(["diff", "--name-only", lastSha, build.commit, "--", ...inputs]) !== "";
  const publish = publicationPlan({ validated: true, headSha: run.head_sha, checkoutSha: build.commit, version: build.version, tagSha, lastSha, firstParent, changed, exists: Boolean(existing) });
  return { publish, ...build, tag, repository, existing: Boolean(existing), tagExists: Boolean(tagSha) };
}
async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
export async function publishArchives(plan, directory, { gh = defaultGithub, cwd = process.cwd() } = {}) {
  if (!plan.publish) return;
  const assets = [];
  for (const archive of ["linux-x64", "darwin-arm64"].flatMap(platform => [`a4s-${plan.version}-${platform}.tar.gz`, `a4s-launch-${platform}.tar.gz`])) {
    const path = join(directory, archive);
    const expected = `${await digest(path)}  ${archive}\n`;
    if (readFileSync(`${path}.sha256`, "utf8") !== expected) throw new Error(`Invalid rebuilt checksum ${archive}`);
    if (plan.existing) {
      const published = gh(["release", "download", plan.tag, "--repo", plan.repository, "--pattern", `${archive}.sha256`, "--output", "-"]);
      if (!new RegExp(`^[a-f0-9]{64}  ${archive.replaceAll(".", "\\.")}\\n$`).test(published)) throw new Error(`Invalid published checksum ${archive}`);
      assertPublishedDigest(archive, expected.slice(0, 64), published.slice(0, 64));
    }
    assets.push(path, `${path}.sha256`);
  }
  if (plan.existing) return; // Matching reruns never upload, update or delete anything.
  if (!plan.tagExists) {
    execFileSync("git", ["tag", plan.tag, plan.commit], { cwd });
    execFileSync("git", ["push", "origin", `refs/tags/${plan.tag}`], { cwd, stdio: "inherit" });
  }
  gh(["release", "create", plan.tag, "--repo", plan.repository, "--verify-tag", "--title", plan.tag, "--notes", "Staged build; station activation is operator-owned.", ...assets]);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const plan = planPublication({ cwd: process.cwd(), event: JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")), inputs: JSON.parse(process.env.A4S_SHIPPED_INPUTS) });
  if (process.argv[2] === "plan") {
    if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required");
    appendFileSync(process.env.GITHUB_OUTPUT, `publish=${plan.publish}\n`);
    console.log(JSON.stringify(plan));
  } else if (process.argv[2] === "publish") await publishArchives(plan, resolve("dist"));
  else throw new Error("Usage: node scripts/publish-a4s.mjs plan|publish");
}
