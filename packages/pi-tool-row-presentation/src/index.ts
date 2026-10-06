import { existsSync } from "node:fs";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { sliceByColumn } from "@earendil-works/pi-tui";
import type {
	ExtensionAPI as PionExtensionAPI,
	ToolRendererRegistration,
	ToolRendererResolver,
	ToolRenderers,
} from "@pablontiv/pion";
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

interface RegistrationDependencies {
	readonly globalPath?: string;
	readonly fileExists?: (path: string) => boolean;
	readonly readMode?: (path: string) => ToolRowsMode | undefined;
	readonly writeMode?: (mode: ToolRowsMode, path: string) => void;
}

type SettingsContext = Pick<ExtensionCommandContext, "hasUI" | "ui">;
type ShortcutContext = Pick<ExtensionContext, "ui">;

class CompactToolRow {
	public constructor(private readonly toolName: string) {}

	public render(width: number): string[] {
		return [sliceByColumn(this.toolName, 0, Math.max(0, width), true)];
	}

	public invalidate(): void {}
}

class HiddenToolRow {
	public render(): string[] {
		return [];
	}

	public invalidate(): void {}
}

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
	let rendererEnabled = false;

	const resolver: ToolRendererResolver = (toolName, next) => {
		const inherited = next();
		if (!rendererEnabled || currentMode === "full") return inherited;
		return toolRowRenderers(toolName, currentMode, inherited);
	};
	const registration = registerToolRenderer(pi, resolver);
	if (registration !== undefined) rendererEnabled = true;

	const applyEffectiveMode = (): void => {
		const nextMode = projectMode ?? globalMode;
		if (nextMode === currentMode) return;
		currentMode = nextMode;
		registration?.invalidate();
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
		if (!registration) {
			ctx.ui.notify(
				"Tool row mode was saved. This host version cannot apply tool row presentation.",
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
			const globalIndex = TOOL_ROW_MODES.indexOf(globalMode);
			const nextMode = TOOL_ROW_MODES[(globalIndex + 1) % TOOL_ROW_MODES.length] ?? "full";
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

function registerToolRenderer(
	pi: ExtensionAPI,
	resolver: ToolRendererResolver,
): ToolRendererRegistration | undefined {
	const register = (pi as unknown as Partial<Pick<PionExtensionAPI, "registerToolRenderer">>)
		.registerToolRenderer;
	if (typeof register !== "function") return undefined;
	const candidate: unknown = register.call(pi, resolver);
	if (!isRecord(candidate) || typeof candidate.invalidate !== "function") return undefined;
	return candidate as unknown as ToolRendererRegistration;
}

function toolRowRenderers(
	toolName: string,
	mode: Exclude<ToolRowsMode, "full">,
	inherited: ToolRenderers | undefined,
): ToolRenderers {
	return {
		...inherited,
		renderRow: (_args, _result, _theme, context) => {
			if (context.expanded || context.isError) return undefined;
			return mode === "compact" ? new CompactToolRow(toolName) : new HiddenToolRow();
		},
	};
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
