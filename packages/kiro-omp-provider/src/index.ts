/**
 * omp user extension: kiro provider entrypoint.
 *
 * Installs via symlink: ~/.omp/agent/extensions/kiro.ts -> this file.
 * Registers a custom-api provider whose streamSimple speaks Kiro's
 * GenerateAssistantResponse (legacy CodeWhisperer streaming service).
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
	Usage,
} from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { streamAssistantResponse, type KiroEvent } from "./client";
import { buildConversationState } from "./conversation";
import { KIRO_SEED_MODELS, fetchKiroModels } from "./models";
import { getKiroCredential } from "./token";

const KIRO_API = "kiro-streaming";
const KIRO_PROVIDER = "kiro";
/** Verified for an Enterprise IdC profile. Set via env for your account. */
const KIRO_PROFILE_ARN =
	process.env.KIRO_PROFILE_ARN ?? (() => {
		throw new Error("KIRO_PROFILE_ARN no esta definido (ARN del perfil de CodeWhisperer/IdC)");
	})();

function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function seedModelToConfig(m: (typeof KIRO_SEED_MODELS)[number]) {
	return {
		id: m.id,
		name: m.name,
		reasoning: m.reasoning,
		...(m.thinking
			? {
					thinking: {
						mode: "effort" as const,
						efforts: m.thinking.efforts as ("low" | "medium" | "high" | "xhigh" | "max")[],
						...(m.thinking.defaultLevel ? { defaultLevel: m.thinking.defaultLevel as "high" } : {}),
					},
				}
			: {}),
		input: m.input,
		cost: m.cost,
		contextWindow: m.contextWindow,
		maxTokens: m.maxTokens,
	};
}

/** Models whose control-plane schema declares output_config.effort. */
const EFFORT_MODEL_IDS: Record<string, true> = { "claude-sonnet-4.6": true };

function wireEffort(modelId: string, reasoning: string | undefined): Record<string, unknown> | undefined {
	if (!reasoning || !EFFORT_MODEL_IDS[modelId]) return undefined;
	return { output_config: { effort: reasoning } };
}

interface TextBlock {
	type: "text";
	text: string;
}
interface ThinkingBlock {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string;
}
interface ToolCallBlock {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

async function runKiroTurn(
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions | undefined,
): Promise<void> {
	try {
		const credential = await getKiroCredential();
		const conversationState = buildConversationState(context, {
			modelId: model.id,
			conversationId: crypto.randomUUID(),
			origin: "IDE",
		});
		// Per-toolUse accumulator: kiro streams tool args as JSON string chunks
		// terminated by stop:true; one entry per toolUseId (dynamic keys, order stable).
		const pendingArgs = new Map<string, { block: ToolCallBlock; index: number; raw: string }>();

		let textIndex: number | undefined;
		let thinkingIndex: number | undefined;
		const usage = zeroUsage();
		let stopReason: "stop" | "toolUse" | "length" = "stop";

		await streamAssistantResponse(
			{
				accessToken: credential.accessToken,
				region: credential.region,
				profileArn: KIRO_PROFILE_ARN,
				conversationState,
				additionalModelRequestFields: wireEffort(model.id, options?.reasoning),
				signal: options?.signal,
			},
			(event: KiroEvent) => {
				switch (event.type) {
					case "assistantResponseEvent": {
						const content = event.data["content"];
						if (typeof content !== "string" || content.length === 0) return;
						if (textIndex === undefined) {
							const block: TextBlock = { type: "text", text: "" };
							output.content.push(block);
							textIndex = output.content.length - 1;
							stream.push({ type: "text_start", contentIndex: textIndex, partial: output });
						}
						const block = output.content[textIndex];
						if (block?.type === "text") block.text += content;
						stream.push({ type: "text_delta", contentIndex: textIndex, delta: content, partial: output });
						break;
					}
					case "reasoningContentEvent": {
						const rc = event.data["reasoningContent"];
						if (!rc || typeof rc !== "object") return;
						const text = "text" in rc && typeof rc.text === "string" ? rc.text : undefined;
						const signature = "signature" in rc && typeof rc.signature === "string" ? rc.signature : undefined;
						if (!text || text.length === 0) return;
						if (thinkingIndex === undefined) {
							const block: ThinkingBlock = { type: "thinking", thinking: "" };
							output.content.push(block);
							thinkingIndex = output.content.length - 1;
							stream.push({ type: "thinking_start", contentIndex: thinkingIndex, partial: output });
						}
						const thinkingBlock = output.content[thinkingIndex];
						if (thinkingBlock?.type === "thinking") {
							thinkingBlock.thinking += text;
							if (signature) thinkingBlock.thinkingSignature = signature;
						}
						stream.push({ type: "thinking_delta", contentIndex: thinkingIndex, delta: text, partial: output });
						break;
					}
					case "toolUseEvent": {
						const id = event.data["toolUseId"];
						const name = event.data["name"];
						if (typeof id !== "string" || typeof name !== "string") return;
						let entry = pendingArgs.get(id);
						if (!entry) {
							const block: ToolCallBlock = { type: "toolCall", id, name, arguments: {} };
							output.content.push(block);
							entry = { block, index: output.content.length - 1, raw: "" };
							pendingArgs.set(id, entry);
							stream.push({ type: "toolcall_start", contentIndex: entry.index, partial: output });
						}
						const chunk = event.data["input"];
						if (typeof chunk === "string" && chunk.length > 0) {
							entry.raw += chunk;
							stream.push({
								type: "toolcall_delta",
								contentIndex: entry.index,
								delta: chunk,
								partial: output,
							});
						}
						if (event.data["stop"] === true) {
							entry.block.arguments = parseRawArguments(entry.raw);
							stream.push({
								type: "toolcall_end",
								contentIndex: entry.index,
								toolCall: entry.block,
								partial: output,
							});
							pendingArgs.delete(id);
						}
						break;
					}
					case "metadataEvent": {
						const stop = event.data["stopReason"];
						if (stop === "TOOL_USE") stopReason = "toolUse";
						else if (stop === "MAX_TOKENS" || stop === "LENGTH") stopReason = "length";
						const tokenUsage = event.data["tokenUsage"];
						if (tokenUsage && typeof tokenUsage === "object") {
							usage.input =
								"uncachedInputTokens" in tokenUsage && typeof tokenUsage.uncachedInputTokens === "number"
									? tokenUsage.uncachedInputTokens
									: 0;
							usage.output =
								"outputTokens" in tokenUsage && typeof tokenUsage.outputTokens === "number"
									? tokenUsage.outputTokens
									: 0;
							usage.cacheRead =
								"cacheReadInputTokens" in tokenUsage && typeof tokenUsage.cacheReadInputTokens === "number"
									? tokenUsage.cacheReadInputTokens
									: 0;
							usage.cacheWrite =
								"cacheWriteInputTokens" in tokenUsage && typeof tokenUsage.cacheWriteInputTokens === "number"
									? tokenUsage.cacheWriteInputTokens
									: 0;
							usage.totalTokens =
								"totalTokens" in tokenUsage && typeof tokenUsage.totalTokens === "number"
									? tokenUsage.totalTokens
									: 0;
						}
						break;
					}
					default:
						break;
				}
			},
		);

		output.usage = usage;
		output.stopReason = stopReason;
		stream.push({ type: "done", reason: stopReason, message: output });
	} catch (error) {
		const aborted = options?.signal?.aborted === true;
		output.stopReason = aborted ? "aborted" : "error";
		output.errorMessage = error instanceof Error ? error.message : String(error);
		stream.push({ type: "error", reason: aborted ? "aborted" : "error", error: output });
	}
}

/** Parse accumulated tool-arg JSON chunks into the final arguments object. */
function parseRawArguments(raw: string): Record<string, unknown> {
	if (raw.length === 0) return {};
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		/* fall through to raw fallback */
	}
	return { _raw: raw };
}

export default function kiroExtension(pi: ExtensionAPI): void {
	pi.registerProvider(KIRO_PROVIDER, {
		api: KIRO_API,
		baseUrl: "https://runtime.us-east-1.kiro.dev",
		// omp validates that a models-bearing provider declares apiKey or oauth.
		// The env-var-name form is the canonical pattern for credential-handling
		// extensions: KIRO_API_KEY unset resolves to its literal (truthy for the
		// validation and the prompt-time key gate), while real credentials are
		// resolved by the extension itself from kiro-cli's sqlite. The custom-api
		// dispatch (streamSimple) never sends this value.
		apiKey: "KIRO_API_KEY",
		streamSimple: (model, context, options) => {
			const stream = new AssistantMessageEventStream();
			const output: AssistantMessage = {
				role: "assistant",
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: zeroUsage(),
				stopReason: "stop",
				timestamp: Date.now(),
			};
			stream.push({ type: "start", partial: output });
			void runKiroTurn(stream, output, model, context, options);
			return stream;
		},
		models: KIRO_SEED_MODELS.map(seedModelToConfig),
		fetchDynamicModels: async () => {
			try {
				const credential = await getKiroCredential();
				const live = await fetchKiroModels({
					accessToken: credential.accessToken,
					region: credential.region,
					profileArn: KIRO_PROFILE_ARN,
				});
				return live.map(seedModelToConfig);
			} catch {
				// Offline/unauthenticated: keep the static seed (returned by `models`).
				return KIRO_SEED_MODELS.map(seedModelToConfig);
			}
		},
	});
}
