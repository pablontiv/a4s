import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const TOOL_ROW_PRESENTATION_FILE_NAME = "pi-tool-row-presentation.json";
export const TOOL_ROW_MODES = ["full", "compact", "hidden"] as const;

export type ToolRowsMode = (typeof TOOL_ROW_MODES)[number];

export function isToolRowsMode(value: unknown): value is ToolRowsMode {
	return typeof value === "string" && TOOL_ROW_MODES.includes(value as ToolRowsMode);
}

export function modeFromFile(contents: string | undefined): ToolRowsMode | undefined {
	if (contents === undefined) return undefined;
	try {
		const parsed: unknown = JSON.parse(contents);
		if (!isRecord(parsed) || Object.keys(parsed).length !== 1) return undefined;
		return isToolRowsMode(parsed.mode) ? parsed.mode : undefined;
	} catch {
		return undefined;
	}
}

export function readModeFile(path: string): ToolRowsMode | undefined {
	try {
		return modeFromFile(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

export function serializeMode(mode: ToolRowsMode): string {
	return `${JSON.stringify({ mode }, null, 2)}\n`;
}

export function writeGlobalMode(mode: ToolRowsMode, path = globalModePath()): void {
	const directory = dirname(path);
	mkdirSync(directory, { recursive: true });
	const temporaryPath = join(
		directory,
		`.${TOOL_ROW_PRESENTATION_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`,
	);
	let renamed = false;
	try {
		writeFileSync(temporaryPath, serializeMode(mode), {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
		});
		chmodSync(temporaryPath, 0o600);
		renameSync(temporaryPath, path);
		renamed = true;
	} finally {
		if (!renamed) rmSync(temporaryPath, { force: true });
	}
}

export function globalModePath(
	environment: NodeJS.ProcessEnv = process.env,
	homeDirectory = homedir(),
): string {
	const configuredDirectory = environment.PI_CODING_AGENT_DIR?.trim();
	return join(
		configuredDirectory || join(homeDirectory, ".pi", "agent"),
		TOOL_ROW_PRESENTATION_FILE_NAME,
	);
}

export function projectModePath(cwd: string): string {
	return join(cwd, ".pi", TOOL_ROW_PRESENTATION_FILE_NAME);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
