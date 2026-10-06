import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CompactionConfig } from "./types.ts";

export const PI_CONTEXT_EXPERT_GLOBAL_CONFIG_PATH = "~/.pi/agent/pi-context-expert.json";

const CONFIG_FILE_NAME = "pi-context-expert.json";
const FLAT_CONFIG_KEYS = new Set([
  "compaction.strategy",
  "trigger.mode",
  "evidence.strategy",
]);

/** The safe, backwards-compatible configuration used when no valid opt-in is supplied. */
export const BASIC_COMPACTION_CONFIG: CompactionConfig = {
  compaction: { strategy: "basic" },
  trigger: { mode: "hint" },
  evidence: { strategy: "off" },
};

/** True only for the explicit request-time retrieval opt-in. */
export function isLadderCompaction(config: CompactionConfig): boolean {
  return config.compaction.strategy === "ladder";
}

/** Evidence has a double opt-in: it cannot run without Ladder compaction. */
export function isLadderEvidence(config: CompactionConfig): boolean {
  return config.compaction.strategy === "ladder" && config.evidence.strategy === "ladder";
}

/**
 * Resolves the deliberately small public configuration surface. Invalid or
 * incomplete updates never partially enable an opt-in feature: the complete
 * preceding safe value is retained.
 */
export function resolveCompactionConfig(
  raw: Readonly<Record<string, unknown>> | undefined,
  previous: CompactionConfig = BASIC_COMPACTION_CONFIG,
): CompactionConfig {
  if (!raw) return previous;
  const compactionStrategy = raw["compaction.strategy"] ?? previous.compaction.strategy;
  const triggerMode = raw["trigger.mode"] ?? previous.trigger.mode;
  const evidenceStrategy = raw["evidence.strategy"] ?? previous.evidence.strategy;

  if (
    !isCompactionStrategy(compactionStrategy) ||
    !isTriggerMode(triggerMode) ||
    !isEvidenceStrategy(evidenceStrategy) ||
    (evidenceStrategy === "ladder" && compactionStrategy !== "ladder")
  ) {
    return previous;
  }

  return {
    compaction: { strategy: compactionStrategy },
    trigger: { mode: triggerMode },
    evidence: { strategy: evidenceStrategy },
  };
}

/** Parses the persisted global file without accepting any additional fields. */
export function configurationFromGlobalFile(
  contents: string | undefined,
): Readonly<Record<string, unknown>> {
  if (contents === undefined) return flatConfiguration(BASIC_COMPACTION_CONFIG);

  try {
    const parsed: unknown = JSON.parse(contents);
    if (!isRecord(parsed) || Object.keys(parsed).some((key) => !FLAT_CONFIG_KEYS.has(key))) {
      return flatConfiguration(BASIC_COMPACTION_CONFIG);
    }
    return flatConfiguration(resolveCompactionConfig(parsed, BASIC_COMPACTION_CONFIG));
  } catch {
    return flatConfiguration(BASIC_COMPACTION_CONFIG);
  }
}

/** Serializes the complete supported configuration in its public flat format. */
export function serializeGlobalCompactionConfiguration(config: CompactionConfig): string {
  return `${JSON.stringify(flatConfiguration(config), null, 2)}\n`;
}

/**
 * Reads the configured location. A missing configured file falls back to the
 * former fixed location so existing installations remain active.
 */
export function loadGlobalCompactionConfiguration(
  configPath = globalCompactionConfigPath(),
  legacyPath = legacyGlobalCompactionConfigPath(),
): Readonly<Record<string, unknown>> {
  try {
    return configurationFromGlobalFile(readFileSync(configPath, "utf8"));
  } catch {
    if (configPath !== legacyPath) {
      try {
        return configurationFromGlobalFile(readFileSync(legacyPath, "utf8"));
      } catch {
        // Use the safe default below.
      }
    }
    return configurationFromGlobalFile(undefined);
  }
}

/** Writes a complete configuration through a same-directory atomic rename. */
export function writeGlobalCompactionConfiguration(
  config: CompactionConfig,
  configPath = globalCompactionConfigPath(),
): void {
  const directory = dirname(configPath);
  mkdirSync(directory, { recursive: true });
  const temporaryPath = join(
    directory,
    `.${CONFIG_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`,
  );
  let temporaryFileExists = true;
  try {
    writeFileSync(temporaryPath, serializeGlobalCompactionConfiguration(config), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    temporaryFileExists = true;
    renameSync(temporaryPath, configPath);
    temporaryFileExists = false;
  } finally {
    if (temporaryFileExists) rmSync(temporaryPath, { force: true });
  }
}

/** Resolves the active agent directory and ignores an empty override. */
export function globalCompactionConfigPath(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir(),
): string {
  const configuredDirectory = environment.PI_CODING_AGENT_DIR?.trim();
  return join(
    configuredDirectory || join(homeDirectory, ".pi", "agent"),
    CONFIG_FILE_NAME,
  );
}

/** Returns the fixed path used before PI_CODING_AGENT_DIR support. */
export function legacyGlobalCompactionConfigPath(homeDirectory = homedir()): string {
  return join(homeDirectory, ".pi", "agent", CONFIG_FILE_NAME);
}

export function flatConfiguration(config: CompactionConfig): Readonly<Record<string, unknown>> {
  return {
    "compaction.strategy": config.compaction.strategy,
    "trigger.mode": config.trigger.mode,
    "evidence.strategy": config.evidence.strategy,
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCompactionStrategy(value: unknown): value is CompactionConfig["compaction"]["strategy"] {
  return value === "basic" || value === "ladder";
}

function isTriggerMode(value: unknown): value is CompactionConfig["trigger"]["mode"] {
  return value === "off" || value === "hint" || value === "auto";
}

function isEvidenceStrategy(value: unknown): value is CompactionConfig["evidence"]["strategy"] {
  return value === "off" || value === "ladder";
}
