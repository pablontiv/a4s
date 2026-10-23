/**
 * Convert omp's `Context` (systemPrompt + messages + tools) into Kiro's
 * `conversationState` wire shape for GenerateAssistantResponse.
 *
 * Verified wire rules (each learned from a live 400 then 200):
 * - `tools` must be declared on EVERY userInputMessage, including the one that
 *   carries toolResults — otherwise Bedrock rejects with TOOL_CONFIG_MISSING.
 * - toolResult content blocks are `{"text": "..."}` (member name `text`).
 * - Messages alternate user/assistant; a user message may have empty content
 *   only when it carries toolResults.
 * - Every assistant toolUses[] must be followed by a user message whose
 *   toolResults[] match by toolUseId.
 * - systemPrompt: the legacy target has no top-level system field, so omp's
 *   system prompt is injected as the first user message (clearly delimited).
 * - `origin: "IDE"` unlocks the model set this profile exposes (CLI origin
 *   only serves 2 models).
 */
import type { Context, Message, Tool } from "@oh-my-pi/pi-ai";

export interface KiroToolSpec {
	toolSpecification: {
		name: string;
		description: string;
		inputSchema: { json: Record<string, unknown> };
	};
}

export interface KiroChatMessage {
	userInputMessage?: {
		content: string;
		modelId: string;
		origin: string;
		images?: unknown[];
		userInputMessageContext?: {
			tools?: KiroToolSpec[];
			toolResults?: {
				toolUseId: string;
				content: { text: string }[];
				status: "success" | "error";
			}[];
		};
	};
	assistantResponseMessage?: {
		content: string;
		toolUses?: { toolUseId: string; name: string; input: Record<string, unknown> }[];
		reasoningContent?: { text: string; signature?: string };
	};
}

export interface KiroConversationState {
	conversationId: string;
	history: KiroChatMessage[];
	currentMessage: KiroChatMessage;
	chatTriggerType: "MANUAL" | "CONTINUOUS";
}

export interface BuildConversationOptions {
	modelId: string;
	/** Fresh conversationId per request (stateless mapping, like the OSS kiro bridge). */
	conversationId: string;
	/** Kiro message origin — "IDE" unlocks this profile's full model set. */
	origin?: string;
}

const SYSTEM_PREAMBLE = "[SYSTEM INSTRUCTIONS]\n";
const SYSTEM_EPILOGUE = "\n[END SYSTEM INSTRUCTIONS]";

function flattenText(content: string | { type: string; text?: string }[]): string {
	if (typeof content === "string") return content;
	let text = "";
	for (const block of content) {
		if (block.type === "text" && typeof block.text === "string") text += (text ? "\n" : "") + block.text;
	}
	return text;
}

function toKiroTools(tools: readonly Tool[] | undefined): KiroToolSpec[] | undefined {
	if (!tools || tools.length === 0) return undefined;
	return tools.map(tool => ({
		toolSpecification: {
			name: tool.name,
			description: tool.description ?? "",
			inputSchema: { json: (tool.parameters ?? { type: "object", properties: {} }) as Record<string, unknown> },
		},
	}));
}


function buildUserMessage(
	msg: Extract<Message, { role: "user" }>,
	modelId: string,
	origin: string,
	tools: KiroToolSpec[] | undefined,
): KiroChatMessage {
	return {
		userInputMessage: {
			content: flattenText(msg.content),
			modelId,
			origin,
			images: [],
			userInputMessageContext: tools ? { tools } : undefined,
		},
	};
}

function buildToolResultMessage(
	msg: Extract<Message, { role: "toolResult" }>,
	modelId: string,
	origin: string,
	tools: KiroToolSpec[] | undefined,
): KiroChatMessage {
	const text = flattenText(msg.content) || "(empty tool result)";
	return {
		userInputMessage: {
			content: "",
			modelId,
			origin,
			images: [],
			userInputMessageContext: {
				...(tools ? { tools } : {}),
				toolResults: [
					{
						toolUseId: msg.toolCallId,
						content: [{ text }],
						status: msg.isError ? "error" : "success",
					},
				],
			},
		},
	};
}

function buildAssistantMessage(
	msg: Extract<Message, { role: "assistant" }>,
	modelId: string,
): KiroChatMessage {
	const textParts: string[] = [];
	const toolUses: { toolUseId: string; name: string; input: Record<string, unknown> }[] = [];
	let reasoning: { text: string; signature?: string } | undefined;

	for (const block of msg.content) {
		if (block.type === "text") textParts.push(block.text);
		else if (block.type === "toolCall") {
			toolUses.push({ toolUseId: block.id, name: block.name, input: block.arguments ?? {} });
		} else if (block.type === "thinking") {
			reasoning = { text: block.thinking, ...(block.thinkingSignature ? { signature: block.thinkingSignature } : {}) };
		}
	}

	return {
		assistantResponseMessage: {
			content: textParts.join("\n"),
			...(toolUses.length > 0 ? { toolUses } : {}),
			...(reasoning ? { reasoningContent: reasoning } : {}),
		},
	};
}

/**
 * Build the wire conversationState. The LAST message in `context.messages`
 * becomes currentMessage; everything else becomes history. A trailing
 * toolResult run merges into one user message with multiple toolResults
 * (kiro requires toolResults on a user message and alternating turns).
 */
export function buildConversationState(
	context: Context,
	options: BuildConversationOptions,
): KiroConversationState {
	const origin = options.origin ?? "IDE";
	const tools = toKiroTools(context.tools);
	const messages = [...context.messages];

	// 1. Merge trailing toolResult run into a single user message carrying all results.
	const trailing: Extract<Message, { role: "toolResult" }>[] = [];
	while (messages.length > 0 && messages[messages.length - 1]!.role === "toolResult") {
		trailing.unshift(messages.pop() as Extract<Message, { role: "toolResult" }>);
	}

	const history: KiroChatMessage[] = [];

	// 2. System prompt → first user message (legacy target has no system field).
	const systemPrompt = (context.systemPrompt ?? []).join("\n").trim();
	if (systemPrompt) {
		history.push({
			userInputMessage: {
				content: `${SYSTEM_PREAMBLE}${systemPrompt}${SYSTEM_EPILOGUE}`,
				modelId: options.modelId,
				origin,
				images: [],
				userInputMessageContext: tools ? { tools } : undefined,
			},
		});
	}

	// 3. Map remaining messages. Adjacent toolResults merge into the user turn
	//    they belong to; a user message followed by toolResults carries both.
	for (const msg of messages) {
		if (msg.role === "user") {
			history.push(buildUserMessage(msg, options.modelId, origin, tools));
		} else if (msg.role === "assistant") {
			history.push(buildAssistantMessage(msg, options.modelId));
		} else if (msg.role === "toolResult") {
			// Tool result for an earlier assistant toolUse: attach to the previous
			// user message's context, or synthesize one.
			const prev = history[history.length - 1];
			const asToolResult = {
				toolUseId: msg.toolCallId,
				content: [{ text: flattenText(msg.content) || "(empty tool result)" }],
				status: (msg.isError ? "error" : "success") as "error" | "success",
			};
			if (prev?.userInputMessage) {
				const ctx = prev.userInputMessage.userInputMessageContext ?? {};
				ctx.toolResults = [...(ctx.toolResults ?? []), asToolResult];
				prev.userInputMessage.userInputMessageContext = ctx;
			} else {
				history.push(buildToolResultMessage(msg, options.modelId, origin, tools));
			}
		} else if (msg.role === "developer") {
			history.push({
				userInputMessage: {
					content: flattenText(msg.content),
					modelId: options.modelId,
					origin,
					images: [],
					userInputMessageContext: tools ? { tools } : undefined,
				},
			});
		}
	}

	// 4. Current message: the trailing toolResult run (merged) or the final
	//    user/assistant message.
	let currentMessage: KiroChatMessage;
	if (trailing.length > 0) {
		currentMessage = {
			userInputMessage: {
				content: "",
				modelId: options.modelId,
				origin,
				images: [],
				userInputMessageContext: {
					...(tools ? { tools } : {}),
					toolResults: trailing.map(msg => ({
						toolUseId: msg.toolCallId,
						content: [{ text: flattenText(msg.content) || "(empty tool result)" }],
						status: msg.isError ? "error" : "success",
					})),
				},
			},
		};
	} else {
		const last = messages[messages.length - 1];
		if (last?.role === "user") {
			currentMessage = buildUserMessage(last, options.modelId, origin, tools);
			history.pop();
		} else if (last?.role === "assistant") {
			// Degenerate (assistant-last) transcript: keep it in history and send an
			// explicit continuation prompt as current.
			currentMessage = {
				userInputMessage: {
					content: "continue",
					modelId: options.modelId,
					origin,
					images: [],
					userInputMessageContext: tools ? { tools } : undefined,
				},
			};
		} else {
			currentMessage = {
				userInputMessage: {
					content: "",
					modelId: options.modelId,
					origin,
					images: [],
					userInputMessageContext: tools ? { tools } : undefined,
				},
			};
		}
	}

	// 5. History must END with a user message when currentMessage is a user
	//    message carrying toolResults (alternating rule), and never contain two
	//    adjacent user messages (merge them).
	const merged: KiroChatMessage[] = [];
	for (const msg of history) {
		const prev = merged[merged.length - 1];
		if (prev?.userInputMessage && msg.userInputMessage) {
			// merge adjacent user messages
			prev.userInputMessage.content = `${prev.userInputMessage.content}\n${msg.userInputMessage.content}`.trim();
			const ctx = msg.userInputMessage.userInputMessageContext;
			if (ctx?.toolResults) {
				const pctx = prev.userInputMessage.userInputMessageContext ?? {};
				pctx.toolResults = [...(pctx.toolResults ?? []), ...ctx.toolResults];
				prev.userInputMessage.userInputMessageContext = pctx;
			}
		} else {
			merged.push(msg);
		}
	}

	// chatTriggerType MANUAL siempre: "CONTINUOUS" es rechazado con 400
	// REQUEST_BODY_INVALID en este endpoint (verificado en vivo); el trailing
	// toolResults turn funciona igual con MANUAL.
	const chatTriggerType: "MANUAL" = "MANUAL";


	return {
		conversationId: options.conversationId,
		history: merged,
		currentMessage,
		chatTriggerType,
	};
}
