import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import {
  VERSION,
  type AgentSettledEvent,
  type ContextEditEntry,
  type ContextEventResult,
  type ContextWithSystemEvent,
} from "@earendil-works/pi-coding-agent";
import { createCompatiblePiFake } from "./fixtures.ts";

const ROOT = new URL("../../../", import.meta.url);
const MINIMUM_PI_VERSION = "1.0.3";
const MINIMUM_PI_RELEASE = [1, 0, 3] as const;

function supportsPiVersion(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\+.*)?$/.exec(version);
  if (!match) return false;
  const release = [Number(match[1]!), Number(match[2]!), Number(match[3]!)] as const;
  return (
    release[0] > MINIMUM_PI_RELEASE[0] ||
    (release[0] === MINIMUM_PI_RELEASE[0] && release[1] > MINIMUM_PI_RELEASE[1]) ||
    (release[0] === MINIMUM_PI_RELEASE[0] &&
      release[1] === MINIMUM_PI_RELEASE[1] &&
      release[2] >= MINIMUM_PI_RELEASE[2])
  );
}

test("Context Expert has no duplicate private TypeSafe runtime", () => {
  const contextManifest = JSON.parse(readFileSync(new URL("packages/pi-context-expert/package.json", ROOT), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const lock = JSON.parse(readFileSync(new URL("package-lock.json", ROOT), "utf8")) as {
    packages: Record<string, unknown>;
  };
  assert.equal(contextManifest.dependencies?.["@a4s/typesafe"], undefined);
  assert.equal(existsSync(new URL("packages/typesafe", ROOT)), false);
  assert.equal(lock.packages["packages/typesafe"], undefined);
  assert.equal(lock.packages["node_modules/@typesafe-ai/sdk"], undefined);
});

test("development installs the minimum Pi host and approved Pion snapshot", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("packages/pi-context-expert/package.json", ROOT), "utf8"),
  ) as {
    devDependencies: Record<string, string>;
  };
  const lock = JSON.parse(readFileSync(new URL("package-lock.json", ROOT), "utf8")) as {
    packages: Record<string, { version?: string }>;
  };
  const pionVersion = "1.0.2-dev.40713b10ba6db5c6f083026e3367e2af72cea0ea";
  assert.equal(manifest.devDependencies["@earendil-works/pi-coding-agent"], "1.0.3");
  assert.match(manifest.devDependencies["@pablontiv/pion"] ?? "", new RegExp(pionVersion));
  assert.equal(lock.packages["node_modules/@earendil-works/pi-coding-agent"]?.version, "1.0.3");
  assert.equal(lock.packages["node_modules/@earendil-works/pi-ai"]?.version, "1.0.3");
  assert.equal(lock.packages["node_modules/@pablontiv/pion"]?.version, pionVersion);
});

test("the runtime contract declares an inclusive minimum instead of an exact Pi version", () => {
  for (const supported of [MINIMUM_PI_VERSION, "1.0.4", "1.1.0", "2.0.0", "1.0.3+build.1"]) {
    assert.equal(supportsPiVersion(supported), true, `${supported} should be supported`);
  }
  for (const unsupported of ["1.0.2", "0.99.99", "1.0.3-beta.1", "invalid"]) {
    assert.equal(supportsPiVersion(unsupported), false, `${unsupported} should not be supported`);
  }
  assert.equal(supportsPiVersion(VERSION), true, `installed Pi ${VERSION} must be >= ${MINIMUM_PI_VERSION}`);
});

test("agent_settled defers ctx.compact and enters the existing compact hook once", async () => {
  const runtime = createCompatiblePiFake();
  runtime.pi.on("session_before_compact", () => {
    runtime.beforeCompactCalls += 1;
    return { cancel: true };
  });
  runtime.pi.on("agent_settled", (_event, ctx) => {
    ctx.compact();
  });

  await runtime.emit("agent_settled");

  assert.equal(runtime.compactCalls, 1);
  assert.equal(runtime.beforeCompactCalls, 1);
  assert.equal(runtime.compactCallsWhileSettling, 0, "agent_settled work must not re-enter the settled handler");
  assert.equal(runtime.nativeFallbackCalls, 0, "a cancelled custom compaction must not fall back to native compaction");
});

test("the compatibility fake derives lifecycle payloads, results, and context", async () => {
  const runtime = createCompatiblePiFake();
  runtime.pi.on("agent_settled", (event, ctx) => {
    const settled: AgentSettledEvent = event;
    assert.equal(settled.type, "agent_settled");
    ctx.compact({ onComplete: () => {} });
  });

  const contextEdit: ContextEditEntry = {
    type: "context_edit",
    id: "edit-1",
    parentId: null,
    timestamp: "2026-09-22T00:00:00.000Z",
    targetId: "message-1",
    replacement: null,
  };
  assert.equal(contextEdit.id, "edit-1");

  const supplied: ContextWithSystemEvent["messages"] = [{ role: "system", content: "normal", timestamp: 0 }];
  const projected: ContextEventResult = await runtime.emit("context_with_system", { messages: supplied });
  assert.deepEqual(projected, { messages: supplied });
});

test("a failed context projection leaves Pi's supplied system context unchanged", async () => {
  const runtime = createCompatiblePiFake();
  runtime.pi.on("context_with_system", () => {
    throw new Error("projection failed");
  });

  const supplied: ContextWithSystemEvent["messages"] = [{ role: "system", content: "normal", timestamp: 0 }];
  const projected: ContextEventResult = await runtime.emit("context_with_system", { messages: supplied });

  assert.deepEqual(projected, { messages: supplied });
  assert.deepEqual(supplied, [{ role: "system", content: "normal", timestamp: 0 }]);
});
