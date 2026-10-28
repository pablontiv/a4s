#!/usr/bin/env node
import { appendFileSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const directory = process.env.A4S_FIXTURE_RELEASES;
if (!directory) throw new Error("A4S_FIXTURE_RELEASES is required by the GitHub fixture");
const path = join(directory, "fixture.json");
const state = JSON.parse(readFileSync(path, "utf8"));
const args = process.argv.slice(2);
appendFileSync(join(directory, "gh-calls.jsonl"), `${JSON.stringify(args)}\n`);
const json = value => process.stdout.write(JSON.stringify(value));
if (args[0] === "api") {
  const route = args.find(value => value.startsWith("repos/"));
  const base = `repos/${state.repository}/`;
  if (!route?.startsWith(base)) throw new Error(`Unexpected release repository ${route}`);
  const resource = route.slice(base.length);
  if (resource.startsWith("git/ref/tags/")) {
    const tag = decodeURIComponent(resource.slice(13));
    const commit = state.moving[tag] ?? state.releases.find(value => value.tag_name === tag)?.commit;
    if (!commit) throw new Error(`Missing tag ${tag}`);
    json({ object: { type: "commit", sha: commit } });
  } else if (resource.startsWith("releases/tags/")) {
    const tag = decodeURIComponent(resource.slice(14));
    const release = state.releases.find(value => value.tag_name === tag);
    if (!release) throw new Error(`Missing exact release ${tag}`);
    json({ ...release, draft: release.draft ?? false, prerelease: release.prerelease ?? false });
  } else if (resource.startsWith("releases?")) {
    json([state.releases.map(value => ({ ...value, draft: value.draft ?? false, prerelease: value.prerelease ?? false }))]);
  } else throw new Error(`Unexpected GitHub route ${resource}`);
} else if (args[0] === "release" && args[1] === "download") {
  const tag = args[2];
  const release = state.releases.find(value => value.tag_name === tag);
  if (!release || !/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error(`Only exact published release downloads are permitted: ${tag}`);
  const asset = args[args.indexOf("--pattern") + 1];
  const output = args[args.indexOf("--output") + 1];
  if (!asset.startsWith(`a4s-${tag}-`) || asset.includes("/")) throw new Error(`Unexpected asset ${asset}`);
  const source = join(directory, asset);
  if (output === "-") process.stdout.write(readFileSync(source));
  else copyFileSync(source, output);
  if (state.moveAfterResolution && asset.endsWith(".sha256")) {
    state.moving[state.moveAfterResolution.tag] = state.moveAfterResolution.commit;
    delete state.moveAfterResolution;
    writeFileSync(path, JSON.stringify(state));
  }
} else throw new Error(`Unexpected gh fixture call ${JSON.stringify(args)}`);
