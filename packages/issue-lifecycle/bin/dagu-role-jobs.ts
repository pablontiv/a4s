#!/usr/bin/env bun
import { main } from "../src/commands/role-jobs.ts";
await main(process.argv.slice(2));
