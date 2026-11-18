#!/usr/bin/env node
// Run the t3 CLI that matches the running server of $T3_HOME: `t3cli.mjs <t3 args...>`.
import { spawnSync } from "node:child_process";
import { resolveT3 } from "./lib.mjs";

const home = process.env.T3_HOME;
if (!home) { console.error("T3_HOME is required"); process.exit(30); }
const t3 = resolveT3(home, process.env.T3_VERSIONS_DIR);
if (t3.error) { console.error(t3.error); process.exit(30); }
const r = spawnSync(t3.bin, [...process.argv.slice(2), "--base-dir", home], { stdio: "inherit" });
process.exit(r.status ?? 30);
