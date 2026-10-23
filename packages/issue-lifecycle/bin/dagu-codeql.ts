#!/usr/bin/env node
import { observeCodeScanning } from "../src/code-scanning.ts";

const [repo = "", pr = "", sha = "", security = "", alerts = ""] = process.argv.slice(2);
console.log(JSON.stringify(observeCodeScanning(repo, pr, sha, { security, alerts })));
