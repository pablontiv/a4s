#!/usr/bin/env bun
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { authorizeFeedbackOwner, githubFeedbackTransport, IssueFeedback, type FeedbackInput } from "../src/issue-feedback.ts";

let feedback: IssueFeedback | undefined;
try {
  const [command, statePath, ...args] = process.argv.slice(2);
  const arities: Record<string, number> = { configure: 4, emit: 2, publish: 0, poll: 0, project: 0, tick: 0, serve: 0, list: 0, claim: 1 };
  if (!command || !statePath || !Object.hasOwn(arities, command) || args.length !== arities[command] || args.some(arg => !arg)) {
    throw new Error("Usage: dagu-issue-feedback configure|emit|publish|poll|project|tick|serve|list|claim <run-state> [arguments]");
  }
  const state = realpathSync(statePath);
  const owner = process.env.OMP_SESSION_ID || "";
  if (command === "configure") {
    const [sha, iteration, attempt, publisher] = args;
    if (!/^[a-f0-9]{40}$/.test(sha!) || !/^(0|[1-9][0-9]*)$/.test(iteration!) || !Number.isSafeInteger(Number(iteration))) {
      throw new Error("configure requires SHA ITERATION ATTEMPT PUBLISHER; SHA must be 40 lowercase hex characters and ITERATION a nonnegative safe integer");
    }
    const scope = authorizeFeedbackOwner(state, owner);
    const jobs = join(state, "role-jobs"); mkdirSync(jobs, { recursive: true, mode: 0o700 });
    feedback = new IssueFeedback(state);
    feedback.configure({ schemaVersion: 1, ...scope, owner, publisher: publisher!, jobs: realpathSync(jobs),
      candidate: { sha: sha!, iteration: Number(iteration), attempt: attempt! } }, owner);
    console.log(JSON.stringify(feedback.policy()));
  } else {
    if (command === "claim") authorizeFeedbackOwner(state, owner);
    realpathSync(join(state, "issue-feedback.sqlite"));
    feedback = new IssueFeedback(state);
    if (command === "emit") {
      const [directory, inputPath] = args;
      console.log(JSON.stringify(feedback.emit(realpathSync(directory!), JSON.parse(readFileSync(inputPath!, "utf8")) as FeedbackInput)));
    } else if (command === "publish") console.log(JSON.stringify(feedback.publish(githubFeedbackTransport())));
    else if (command === "poll") console.log(JSON.stringify(feedback.poll(githubFeedbackTransport())));
    else if (command === "project") { feedback.project(githubFeedbackTransport()); console.log(JSON.stringify(feedback.receipts())); }
    else if (command === "tick" || command === "serve") {
      const transport = githubFeedbackTransport();
      let stopped = false;
      const stop = () => { stopped = true; };
      process.once("SIGTERM", stop); process.once("SIGINT", stop);
      try {
        do {
          feedback.publish(transport); feedback.poll(transport); feedback.project(transport);
          console.log(JSON.stringify({ receipts: feedback.receipts(), work: feedback.work() }));
          if (command === "serve" && !stopped) await delay(60_000);
        } while (command === "serve" && !stopped);
      } finally { process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop); }
    }
    else if (command === "list") console.log(JSON.stringify({ receipts: feedback.receipts(), work: feedback.work() }));
    else if (command === "claim") console.log(JSON.stringify(feedback.claim(args[0]!, owner)));
  }
} catch (error) {
  console.error(`DAGU_ISSUE_FEEDBACK_BLOCKED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally { feedback?.close(); }
