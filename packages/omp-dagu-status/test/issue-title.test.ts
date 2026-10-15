import assert from "node:assert/strict";
import test from "node:test";
import { IssueTitles, issueSlug } from "../src/issue-title.ts";

const signal = new AbortController().signal;

test("issue slugs normalize accents, punctuation, truncation and empty titles", () => {
  assert.equal(issueSlug("Ácción naïve: déjà vu!"), "accion-naive-deja-vu");
  assert.equal(issueSlug("  Hello, world!!! C++  "), "hello-world-c");
  assert.equal(issueSlug("1234567890123456789012345678901 extra"), "1234567890123456789012345678901");
  assert.equal(issueSlug("abcdefghijklmnopqrstuvwxyz123456789"), "abcdefghijklmnopqrstuvwxyz123456");
  assert.equal(issueSlug(" — !!! "), undefined);
  assert.equal(issueSlug(""), undefined);
});

test("successful issue title lookups are cached across repeated discoveries", async () => {
  let calls = 0;
  const titles = new IssueTitles(async issue => {
    calls += 1;
    return `Issue ${issue}`;
  });

  assert.equal(await titles.load("169", signal), true);
  assert.equal(await titles.load("169", signal), true);
  assert.equal(calls, 1);
  assert.equal(titles.get("169"), "issue-169");
});

test("failed issue title lookups are retried", async () => {
  let calls = 0;
  const titles = new IssueTitles(async () => {
    calls += 1;
    if (calls === 1) throw new Error("gh unavailable");
    return "Recovered title";
  });

  assert.equal(await titles.load("169", signal), false);
  assert.equal(titles.has("169"), false);
  assert.equal(await titles.load("169", signal), true);
  assert.equal(calls, 2);
  assert.equal(titles.get("169"), "recovered-title");
});

test("concurrent issue title lookups share one in-flight request", async () => {
  let calls = 0;
  let release!: (title: string) => void;
  const titles = new IssueTitles(async () => {
    calls += 1;
    return new Promise<string>(resolve => { release = resolve; });
  });

  const first = titles.load("169", signal);
  const second = titles.load("169", signal);
  await Promise.resolve();
  assert.equal(calls, 1);
  release("Concurrent title");
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(titles.get("169"), "concurrent-title");
});

test("a successful empty title is cached without a slug", async () => {
  let calls = 0;
  const titles = new IssueTitles(async () => {
    calls += 1;
    return "!!!";
  });

  assert.equal(await titles.load("169", signal), true);
  assert.equal(await titles.load("169", signal), true);
  assert.equal(calls, 1);
  assert.equal(titles.has("169"), true);
  assert.equal(titles.get("169"), undefined);
});
