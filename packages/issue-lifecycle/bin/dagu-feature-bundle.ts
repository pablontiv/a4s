#!/usr/bin/env node
import { main } from "../src/commands/bundle.ts";
await main(process.argv.slice(2));
