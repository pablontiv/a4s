import { existsSync } from "node:fs";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	globalModePath,
	isToolRowsMode,
	projectModePath,
	readModeFile,
	TOOL_ROW_MODES,
	type ToolRowsMode,
	writeGlobalMode,
} from "./config.ts";

export const TOOL_ROW_PRESENTATION_SETTINGS_COMMAND = "pi-tool-row-presentation-settings";

interface TranscriptBlock {
	readonly kind: string;
	readonly subtype?: string;
}

interface TranscriptPolicyRegistration {
	invalidate(): void;
}

interface TranscriptPolicyAPI {
	registerTranscriptPresentationPolicy(
		policy: (block: TranscriptBlock) => { density: "full" | "summary" | "hidden" } | undefined,
	): TranscriptPolicyRegistration;
}

interface RegistrationDependencies {
	readonly globalPath?: string;
	readonly fileExists?: (path: string) => boolean;
	readonly readMode?: (path: string) => ToolRowsMode | undefined;
	readonly writeMode?: (mode: ToolRowsMode, path: string) => void;
}

type SettingsContext = Pick<ExtensionCommandContext, "hasUI" | "ui">;
type ShortcutContext = Pick<ExtensionContext, "ui">;

export default function toolRowPresentation(pi: ExtensionAPI): void {
	registerToolRowPresentation(pi);
}

export function registerToolRowPresentation(
	pi: ExtensionAPI,
	dependencies: RegistrationDependencies = {},
): void {
	const configPath = dependencies.globalPath ?? globalModePath();
	const fileExists = dependencies.fileExists ?? existsSync;
	const readMode = dependencies.readMode ?? readModeFile;
	const writeMode = dependencies.writeMode ?? writeGlobalMode;
	let globalMode: ToolRowsMode = "full";
	let projectMode: ToolRowsMode | undefined;
	let currentMode: ToolRowsMode = "full";

	const policyApi = transcriptPolicyAPI(pi);
	const presentation = policyApi?.registerTranscriptPresentationPolicy((block) => {
		if (block.kind === "tool") {
			return { density: currentMode === "compact" ? "summary" : currentMode };
		}
		if (
			currentMode === "hidden" &&
			block.kind === "thinking" &&
			block.subtype === "orphaned-thinking-placeholder"
		) {
			return { density: "hidden" };
		}
		return undefined;
	});

	const applyEffectiveMode = (): void => {
		const nextMode = projectMode ?? globalMode;
		if (nextMode === currentMode) return;
		currentMode = nextMode;
		presentation?.invalidate();
	};

	const saveGlobalMode = (
		nextMode: ToolRowsMode,
		ctx: SettingsContext | ShortcutContext,
	): void => {
		try {
			writeMode(nextMode, configPath);
		} catch {
			ctx.ui.notify("Tool row presentation could not save its settings.", "error");
			return;
		}

		globalMode = nextMode;
		applyEffectiveMode();
		if (!presentation) {
			ctx.ui.notify(
				"Tool row mode was saved. This Pi version cannot apply transcript presentation.",
				"warning",
			);
			return;
		}
		if (projectMode !== undefined) {
			ctx.ui.notify(
				`Global tool rows saved: ${nextMode}. Project override remains: ${projectMode}.`,
				"info",
			);
			return;
		}
		ctx.ui.notify(`Tool rows: ${nextMode}`, "info");
	};

	pi.on("session_start", (_event, ctx) => {
		globalMode = loadGlobalMode(pi.getSettings(), configPath, fileExists, readMode, writeMode);
		projectMode = ctx.isProjectTrusted() ? readMode(projectModePath(ctx.cwd)) : undefined;
		applyEffectiveMode();
	});

	pi.registerCommand(TOOL_ROW_PRESENTATION_SETTINGS_COMMAND, {
		description: "Configure tool row presentation",
		handler: async (_args, ctx) => {
			await runSettingsCommand(ctx, currentMode, (mode) => saveGlobalMode(mode, ctx));
		},
	});

	pi.registerShortcut("ctrl+alt+o", {
		description: "Cycle tool row presentation",
		handler: (ctx) => {
			const currentIndex = TOOL_ROW_MODES.indexOf(currentMode);
			const nextMode = TOOL_ROW_MODES[(currentIndex + 1) % TOOL_ROW_MODES.length] ?? "full";
			saveGlobalMode(nextMode, ctx);
		},
	});
}

export async function runSettingsCommand(
	ctx: SettingsContext,
	currentMode: ToolRowsMode,
	save: (mode: ToolRowsMode) => void,
): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("Tool row presentation settings require an interactive UI.", "warning");
		return;
	}

	const selected = await ctx.ui.select(`Tool rows (current: ${currentMode})`, [
		"full",
		"compact",
		"hidden",
		"Reset",
		"Cancel",
	]);
	if (selected === "Reset") {
		save("full");
		return;
	}
	if (isToolRowsMode(selected)) save(selected);
}

export function migratedMode(settings: unknown): ToolRowsMode | undefined {
	if (!isRecord(settings)) return undefined;
	const extensionSettings = settings.extensionSettings;
	if (isRecord(extensionSettings)) {
		const extensionMode = extensionSettings["a4s.tool-rows.mode"];
		if (isToolRowsMode(extensionMode)) return extensionMode;
	}
	return isToolRowsMode(settings.toolRowsMode) ? settings.toolRowsMode : undefined;
}

function loadGlobalMode(
	settings: unknown,
	configPath: string,
	fileExists: (path: string) => boolean,
	readMode: (path: string) => ToolRowsMode | undefined,
	writeMode: (mode: ToolRowsMode, path: string) => void,
): ToolRowsMode {
	if (fileExists(configPath)) return readMode(configPath) ?? "full";
	const legacyMode = migratedMode(settings);
	if (legacyMode === undefined) return "full";
	try {
		writeMode(legacyMode, configPath);
		return legacyMode;
	} catch {
		return "full";
	}
}

function transcriptPolicyAPI(pi: ExtensionAPI): TranscriptPolicyAPI | undefined {
	const candidate = pi as unknown as Partial<TranscriptPolicyAPI>;
	return typeof candidate.registerTranscriptPresentationPolicy === "function"
		? (candidate as TranscriptPolicyAPI)
		: undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
