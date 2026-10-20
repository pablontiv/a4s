import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BASIC_COMPACTION_CONFIG,
  configurationFromGlobalFile,
  globalCompactionConfigPath,
  legacyGlobalCompactionConfigPath,
  loadGlobalCompactionConfiguration,
  resolveCompactionConfig,
  serializeGlobalCompactionConfiguration,
  writeGlobalCompactionConfiguration,
} from "../src/config.ts";

const BASIC_FLAT_CONFIG = {
  "compaction.strategy": "basic",
  "trigger.mode": "hint",
  "evidence.strategy": "off",
};

test("default configuration offers a compaction hint", () => {
  assert.deepEqual(resolveCompactionConfig(undefined), {
    compaction: { strategy: "basic" },
    trigger: { mode: "hint" },
    evidence: { strategy: "off" },
  });
});

test("invalid configuration preserves the previous safe value", () => {
  assert.deepEqual(
    resolveCompactionConfig({ "evidence.strategy": "ladder" }, BASIC_COMPACTION_CONFIG),
    BASIC_COMPACTION_CONFIG,
  );
});

test("valid opt-in trigger config preserves basic compaction and disabled Evidence", () => {
  assert.deepEqual(
    resolveCompactionConfig({ "trigger.mode": "auto" }, BASIC_COMPACTION_CONFIG),
    {
      compaction: { strategy: "basic" },
      trigger: { mode: "auto" },
      evidence: { strategy: "off" },
    },
  );
});

test("global file accepts only the three flat non-secret mode keys", () => {
  assert.deepEqual(
    configurationFromGlobalFile(JSON.stringify({
      "compaction.strategy": "ladder",
      "trigger.mode": "off",
      "evidence.strategy": "ladder",
    })),
    {
      "compaction.strategy": "ladder",
      "trigger.mode": "off",
      "evidence.strategy": "ladder",
    },
  );
});

test("missing, malformed, and non-object global files fail closed to basic", () => {
  assert.deepEqual(configurationFromGlobalFile(undefined), BASIC_FLAT_CONFIG);
  assert.deepEqual(configurationFromGlobalFile("{"), BASIC_FLAT_CONFIG);
  assert.deepEqual(configurationFromGlobalFile("null"), BASIC_FLAT_CONFIG);
  assert.deepEqual(configurationFromGlobalFile("[]"), BASIC_FLAT_CONFIG);
  assert.deepEqual(configurationFromGlobalFile('"ladder"'), BASIC_FLAT_CONFIG);
});

test("unknown global fields fail closed instead of projecting selected keys", () => {
  assert.deepEqual(
    configurationFromGlobalFile(JSON.stringify({
      "compaction.strategy": "ladder",
      "trigger.mode": "off",
      "evidence.strategy": "off",
      TYPESAFE_API_KEY: "must-not-be-read-as-configuration",
    })),
    BASIC_FLAT_CONFIG,
  );
});

test("invalid global values and combinations fail closed to the complete basic config", () => {
  assert.deepEqual(
    configurationFromGlobalFile(JSON.stringify({
      "compaction.strategy": "ladder",
      "trigger.mode": "surprise",
      "evidence.strategy": "off",
    })),
    BASIC_FLAT_CONFIG,
  );
  assert.deepEqual(
    configurationFromGlobalFile(JSON.stringify({
      "compaction.strategy": "basic",
      "trigger.mode": "off",
      "evidence.strategy": "ladder",
    })),
    BASIC_FLAT_CONFIG,
  );
});

test("global configuration serialization round trips all supported values", () => {
  const config = {
    compaction: { strategy: "ladder" as const },
    trigger: { mode: "auto" as const },
    evidence: { strategy: "ladder" as const },
  };
  assert.deepEqual(
    resolveCompactionConfig(configurationFromGlobalFile(serializeGlobalCompactionConfiguration(config))),
    config,
  );
});

test("global configuration writes atomically with mode 0600", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-context-expert-config-"));
  const configPath = join(root, "agent", "pi-context-expert.json");
  try {
    writeGlobalCompactionConfiguration({
      compaction: { strategy: "ladder" },
      trigger: { mode: "off" },
      evidence: { strategy: "ladder" },
    }, configPath);

    assert.deepEqual(configurationFromGlobalFile(readFileSync(configPath, "utf8")), {
      "compaction.strategy": "ladder",
      "trigger.mode": "off",
      "evidence.strategy": "ladder",
    });
    assert.equal(statSync(configPath).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(join(root, "agent")), ["pi-context-expert.json"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the active path uses a non-empty PI_CODING_AGENT_DIR and keeps the fixed fallback", () => {
  const home = join(tmpdir(), "context-expert-home");
  assert.equal(
    globalCompactionConfigPath({ PI_CODING_AGENT_DIR: " /tmp/custom-pi-agent " }, home),
    "/tmp/custom-pi-agent/pi-context-expert.json",
  );
  assert.equal(
    globalCompactionConfigPath({ PI_CODING_AGENT_DIR: "  " }, home),
    join(home, ".pi", "agent", "pi-context-expert.json"),
  );
  assert.equal(
    legacyGlobalCompactionConfigPath(home),
    join(home, ".pi", "agent", "pi-context-expert.json"),
  );
});

test("a missing configured path reads the former fixed path", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-context-expert-fallback-"));
  const configuredPath = join(root, "custom", "pi-context-expert.json");
  const legacyPath = join(root, "legacy", "pi-context-expert.json");
  try {
    mkdirSync(join(root, "legacy"), { recursive: true });
    writeFileSync(legacyPath, JSON.stringify({
      "compaction.strategy": "ladder",
      "trigger.mode": "hint",
      "evidence.strategy": "off",
    }));
    assert.deepEqual(loadGlobalCompactionConfiguration(configuredPath, legacyPath), {
      "compaction.strategy": "ladder",
      "trigger.mode": "hint",
      "evidence.strategy": "off",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a configured path read error other than ENOENT does not use the former path", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-context-expert-no-fallback-"));
  const configuredPath = join(root, "configured-directory");
  const legacyPath = join(root, "legacy", "pi-context-expert.json");
  try {
    mkdirSync(configuredPath);
    mkdirSync(join(root, "legacy"));
    writeFileSync(legacyPath, JSON.stringify({
      "compaction.strategy": "ladder",
      "trigger.mode": "auto",
      "evidence.strategy": "ladder",
    }));

    assert.deepEqual(
      loadGlobalCompactionConfiguration(configuredPath, legacyPath),
      BASIC_FLAT_CONFIG,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
