/**
 * Model catalog for the kiro provider.
 *
 * Seed = live control-plane snapshot (GET management.{region}.kiro.dev
 * List-Available-Models?origin=IDE) taken 2026-10-20 for this profile; the
 * extension's fetchDynamicModels refreshes it through omp's model cache
 * (24h TTL) and the seed remains as offline fallback.
 */
import type { KiroDeviceRegistration, KiroStoredToken } from "./token";

export interface KiroModelConfig {
	id: string;
	name: string;
	reasoning: boolean;
	thinking?: { mode: "effort"; efforts: string[]; defaultLevel?: string };
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
}

/** Fixed per-model rows from the 2026-10-20 control-plane listing. */
export const KIRO_SEED_MODELS: readonly KiroModelConfig[] = [
	{
		id: "claude-sonnet-4.6",
		name: "Claude Sonnet 4.6 (Kiro)",
		reasoning: true,
		thinking: { mode: "effort", efforts: ["low", "medium", "high", "max"], defaultLevel: "high" },
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 64_000,
	},
	{
		id: "claude-sonnet-4.5",
		name: "Claude Sonnet 4.5 (Kiro)",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	},
	{
		id: "claude-haiku-4.5",
		name: "Claude Haiku 4.5 (Kiro)",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	},
	{
		id: "claude-opus-4.5",
		name: "Claude Opus 4.5 (Kiro)",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	},
	{
		id: "deepseek-3.2",
		name: "DeepSeek 3.2 (Kiro)",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 164_000,
		maxTokens: 64_000,
	},
	{
		id: "glm-5",
		name: "GLM-5 (Kiro)",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	},
	{
		id: "qwen3-coder-next",
		name: "Qwen3 Coder Next (Kiro)",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 256_000,
		maxTokens: 64_000,
	},
	{
		id: "minimax-m2.5",
		name: "MiniMax M2.5 (Kiro)",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 196_000,
		maxTokens: 64_000,
	},
	{
		id: "auto",
		name: "Kiro Auto",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 64_000,
	},
];

/** Kiro token/profile facts needed by the live fetch. */
export interface KiroCatalogCredentials {
	accessToken: string;
	region: string;
	profileArn: string;
}

interface ControlPlaneModel {
	modelId?: string;
	modelName?: string;
	tokenLimits?: { maxInputTokens?: number; maxOutputTokens?: number };
	supportedInputTypes?: string[];
	additionalModelRequestFieldsSchema?: unknown;
}

function effortEnumOf(schema: unknown): string[] | undefined {
	if (!schema || typeof schema !== "object") return undefined;
	if (!("properties" in schema) || typeof schema.properties !== "object" || schema.properties === null) return undefined;
	const properties = schema.properties;
	if (!("output_config" in properties) || typeof properties.output_config !== "object" || properties.output_config === null)
		return undefined;
	const outputConfig = properties.output_config;
	if (!("properties" in outputConfig) || typeof outputConfig.properties !== "object" || outputConfig.properties === null)
		return undefined;
	const props = outputConfig.properties;
	if (!("effort" in props) || typeof props.effort !== "object" || props.effort === null) return undefined;
	const effort = props.effort;
	if (!("enum" in effort) || !Array.isArray(effort.enum)) return undefined;
	return effort.enum.every(e => typeof e === "string") ? (effort.enum as string[]) : undefined;
}
/**
 * Fetch the live catalog from the control plane (origin IDE — this profile's
 * full model set). Returns seed-compatible rows; throws on HTTP failure so
 * callers keep their static fallback.
 */
export async function fetchKiroModels(creds: KiroCatalogCredentials): Promise<KiroModelConfig[]> {
	const url = new URL(`https://management.${creds.region}.kiro.dev/List-Available-Models`);
	url.searchParams.set("origin", "IDE");
	url.searchParams.set("profileArn", creds.profileArn);
	const res = await fetch(url, {
		headers: { Authorization: `Bearer ${creds.accessToken}` },
		signal: AbortSignal.timeout(20_000),
	});
	let models: unknown;
	if (raw && typeof raw === "object" && "models" in raw) {
		models = (raw as Record<string, unknown>).models;
	}
	if (!Array.isArray(models)) throw new Error("kiro List-Available-Models: no models array");
	for (const entry of models) {
		if (!entry || typeof entry !== "object") continue;
		const model = entry as ControlPlaneModel;
		if (typeof model.modelId !== "string" || model.modelId.length === 0) continue;
		const limits = model.tokenLimits ?? {};
		const efforts = effortEnumOf(model.additionalModelRequestFieldsSchema);
		const inputs = model.supportedInputTypes ?? ["TEXT"];
		out.push({
			id: model.modelId,
			name: model.modelName ?? model.modelId,
			reasoning: true,
			...(efforts ? { thinking: { mode: "effort" as const, efforts } } : {}),
			input: inputs.flatMap(t => (t === "IMAGE" ? ["image" as const] : t === "TEXT" ? ["text" as const] : [])),
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: limits.maxInputTokens ?? 200_000,
			maxTokens: limits.maxOutputTokens ?? 64_000,
		});
	}
	return out;
}

/** Narrowing helpers re-exported for tests. */
export type { KiroDeviceRegistration, KiroStoredToken };
