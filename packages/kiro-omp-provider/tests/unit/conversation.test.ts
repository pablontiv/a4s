/**
 * Unit tests del mapper src/conversation.ts.
 *
 * Shapes de entrada: interfaces locales estructuralmente compatibles con los
 * de @oh-my-pi/pi-ai (no hay runtime import — `import type` se borra al
 * transpilar, igual que en src/conversation.ts). El único cast es el puente
 * `asContext`, documentado abajo.
 */
import { describe, expect, it } from "bun:test";
import type { Context } from "@oh-my-pi/pi-ai";
import { buildConversationState, type KiroChatMessage } from "../../src/conversation";

/* ---------- shapes mínimos compatibles con pi-ai (structural typing) ---------- */

interface TestTool {
	name: string;
	description?: string;
	parameters?: Record<string, unknown>;
}

interface TestTextBlock {
	type: "text";
	text: string;
}
interface TestToolCallBlock {
	type: "toolCall";
	id: string;
	name: string;
	arguments?: Record<string, unknown>;
}
interface TestThinkingBlock {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string;
}

interface TestUserMessage {
	role: "user";
	content: string | TestTextBlock[];
	timestamp: number;
}
interface TestAssistantMessage {
	role: "assistant";
	content: (TestTextBlock | TestToolCallBlock | TestThinkingBlock)[];
	timestamp: number;
}
interface TestToolResultMessage {
	role: "toolResult";
	content: string | TestTextBlock[];
	toolCallId: string;
	isError?: boolean;
	timestamp: number;
}
interface TestDeveloperMessage {
	role: "developer";
	content: string | TestTextBlock[];
	timestamp: number;
}

interface TestContext {
	systemPrompt?: string[];
	messages: (TestUserMessage | TestAssistantMessage | TestToolResultMessage | TestDeveloperMessage)[];
	tools?: TestTool[];
}

/**
 * Puente de tipos: TestContext es estructuralmente un Context, pero TS no
 * puede probarlo sin el paquete pi-ai instalado, por eso el doble cast.
 */
function asContext(ctx: TestContext): Context {
	return ctx as unknown as Context;
}

/* ---------- helpers de navegación (afirman shape, fallan con mensaje claro) ---------- */

function userMsg(m: KiroChatMessage) {
	const u = m.userInputMessage;
	if (!u) throw new Error(`expected userInputMessage, got: ${JSON.stringify(m)}`);
	return u;
}

function assistantMsg(m: KiroChatMessage) {
	const a = m.assistantResponseMessage;
	if (!a) throw new Error(`expected assistantResponseMessage, got: ${JSON.stringify(m)}`);
	return a;
}

function toolResults(m: KiroChatMessage) {
	return userMsg(m).userInputMessageContext?.toolResults ?? [];
}

function expectToolsDeclared(msg: ReturnType<typeof userMsg>): void {
	const tools = msg.userInputMessageContext?.tools;
	if (!tools || tools.length === 0) throw new Error("expected tools declared in userInputMessageContext");
}

const OPTS = { modelId: "claude-haiku-4.5", conversationId: "conv-1" };

const TOOLS: TestTool[] = [
	{
		name: "get_weather",
		description: "Weather lookup",
		parameters: { type: "object", properties: { city: { type: "string" } } },
	},
];

describe("conversation mapper", () => {
	it("1. systemPrompt → primer mensaje user con delimitadores [SYSTEM INSTRUCTIONS]", () => {
		const state = buildConversationState(
			asContext({
				systemPrompt: ["Be terse.", "No markdown."],
				messages: [{ role: "user", content: "hi", timestamp: 1 }],
			}),
			OPTS,
		);
		expect(state.history.length).toBe(1);
		const first = userMsg(state.history[0]!);
		expect(first.content).toBe("[SYSTEM INSTRUCTIONS]\nBe terse.\nNo markdown.\n[END SYSTEM INSTRUCTIONS]");
		// el system message lleva modelId y origin IDE como cualquier user message
		expect(first.modelId).toBe("claude-haiku-4.5");
		expect(first.origin).toBe("IDE");
	});

	it("2. user simple → currentMessage con content, modelId, origin IDE y tools declarados", () => {
		const state = buildConversationState(
			asContext({
				systemPrompt: ["sys"],
				messages: [
					{ role: "user", content: "first question", timestamp: 1 },
					{ role: "assistant", content: [{ type: "text", text: "first answer" }], timestamp: 2 },
					{ role: "user", content: "second question", timestamp: 3 },
				],
				tools: TOOLS,
			}),
			OPTS,
		);
		// system y user1 son adyacentes → se mergean (regla de alternancia):
		// history = [user(system + "first question"), assistant]; user2 → current
		expect(state.history.length).toBe(2);
		expect(userMsg(state.history[0]!).content).toBe(
			"[SYSTEM INSTRUCTIONS]\nsys\n[END SYSTEM INSTRUCTIONS]\nfirst question",
		);
		expect(assistantMsg(state.history[1]!).content).toBe("first answer");

		const current = userMsg(state.currentMessage);
		expect(current.content).toBe("second question");
		expect(current.modelId).toBe("claude-haiku-4.5");
		expect(current.origin).toBe("IDE");
		expectToolsDeclared(current);
		// wire rule: tools en CADA userInputMessage (el merge conserva los del system)
		for (const h of state.history) {
			if (h.userInputMessage) expectToolsDeclared(h.userInputMessage);
		}
		expect(state.chatTriggerType).toBe("MANUAL");
	});

	it("3. assistant toolCall + toolResult siguiente → toolUses en history, toolResults en current, CONTINUOUS", () => {
		const state = buildConversationState(
			asContext({
				systemPrompt: ["sys"],
				messages: [
					{ role: "user", content: "weather?", timestamp: 1 },
					{
						role: "assistant",
						content: [
							{ type: "text", text: "checking" },
							{ type: "toolCall", id: "call-1", name: "get_weather", arguments: { city: "Paris" } },
						],
						timestamp: 2,
					},
					{ role: "toolResult", content: "18C sunny", toolCallId: "call-1", timestamp: 3 },
				],
				tools: TOOLS,
			}),
			OPTS,
		);
		// history = [user(system + "weather?" mergeados), assistant(toolUses)]
		expect(state.history.length).toBe(2);
		const assistant = assistantMsg(state.history[1]!);
		expect(assistant.toolUses).toEqual([{ toolUseId: "call-1", name: "get_weather", input: { city: "Paris" } }]);
		expect(assistant.content).toBe("checking");

		// current: user vacío con toolResult matching por toolUseId
		const current = userMsg(state.currentMessage);
		expect(current.content).toBe("");
		const results = toolResults(state.currentMessage);
		expect(results.length).toBe(1);
		expect(results[0]!.toolUseId).toBe("call-1");
		expect(results[0]!.content).toEqual([{ text: "18C sunny" }]);
		expect(results[0]!.status).toBe("success");
		// wire rule: tools también en el mensaje que lleva toolResults
		expectToolsDeclared(current);
		expect(state.chatTriggerType).toBe("MANUAL"); // CONTINUOUS es rechazado 400 por el endpoint (verificado en vivo)
		// alternancia: history termina en el assistant que emitió los toolUses
		expect(state.history[state.history.length - 1]!.assistantResponseMessage).toBeDefined();
	});

	it("4. trailing run de DOS toolResults (dos tool calls distintos) → ambos en un solo user message", () => {
		const state = buildConversationState(
			asContext({
				messages: [
					{ role: "user", content: "weather in two cities", timestamp: 1 },
					{
						role: "assistant",
						content: [
							{ type: "toolCall", id: "call-a", name: "get_weather", arguments: { city: "Paris" } },
							{ type: "toolCall", id: "call-b", name: "get_weather", arguments: { city: "Lyon" } },
						],
						timestamp: 2,
					},
					{ role: "toolResult", content: "Paris 18C", toolCallId: "call-a", timestamp: 3 },
					{ role: "toolResult", content: "Lyon 21C", toolCallId: "call-b", timestamp: 4 },
				],
				tools: TOOLS,
			}),
			OPTS,
		);
		// history: [user, assistant]; current: user con los 2 toolResults
		expect(state.history.length).toBe(2);
		expect(assistantMsg(state.history[1]!).toolUses?.length).toBe(2);

		const current = userMsg(state.currentMessage);
		expect(current.content).toBe("");
		const results = toolResults(state.currentMessage);
		expect(results.map(r => r.toolUseId)).toEqual(["call-a", "call-b"]);
		expect(results.map(r => r.content[0]!.text)).toEqual(["Paris 18C", "Lyon 21C"]);
		expect(results.every(r => r.status === "success")).toBe(true);
		expect(state.chatTriggerType).toBe("MANUAL"); // CONTINUOUS es rechazado 400 por el endpoint (verificado en vivo)
	});

	it("5. toolResult con isError → status \"error\"", () => {
		const state = buildConversationState(
			asContext({
				messages: [
					{ role: "user", content: "go", timestamp: 1 },
					{
						role: "assistant",
						content: [{ type: "toolCall", id: "call-e", name: "get_weather", arguments: {} }],
						timestamp: 2,
					},
					{ role: "toolResult", content: "boom", toolCallId: "call-e", isError: true, timestamp: 3 },
				],
			}),
			OPTS,
		);
		const results = toolResults(state.currentMessage);
		expect(results[0]!.status).toBe("error");
		expect(results[0]!.content).toEqual([{ text: "boom" }]);
	});

	it("6. adjacent user messages se mergean (content concatenado)", () => {
		const state = buildConversationState(
			asContext({
				messages: [
					{ role: "user", content: "first part", timestamp: 1 },
					{ role: "user", content: "second part", timestamp: 2 },
					{ role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 3 },
				],
			}),
			OPTS,
		);
		// el transcript termina en assistant → current "continue"; los dos user quedan mergeados
		expect(state.history.length).toBe(2);
		expect(userMsg(state.history[0]!).content).toBe("first part\nsecond part");
		expect(userMsg(state.currentMessage).content).toBe("continue");
	});

	it("7. transcript degenerado assistant-last → current \"continue\"", () => {
		const state = buildConversationState(
			asContext({
				messages: [
					{ role: "user", content: "q", timestamp: 1 },
					{ role: "assistant", content: [{ type: "text", text: "a" }], timestamp: 2 },
				],
			}),
			OPTS,
		);
		expect(state.history.length).toBe(2);
		// history conserva el assistant final (no se pierde)
		expect(assistantMsg(state.history[1]!).content).toBe("a");
		expect(userMsg(state.currentMessage).content).toBe("continue");
		expect(state.chatTriggerType).toBe("MANUAL");
	});

	it("8. assistant con thinking block → reasoningContent {text, signature}", () => {
		const state = buildConversationState(
			asContext({
				messages: [
					{ role: "user", content: "think", timestamp: 1 },
					{
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "let me consider", thinkingSignature: "sig-abc" },
							{ type: "text", text: "answer" },
						],
						timestamp: 2,
					},
				],
			}),
			OPTS,
		);
		const assistant = assistantMsg(state.history[1]!);
		expect(assistant.reasoningContent).toEqual({ text: "let me consider", signature: "sig-abc" });
		expect(assistant.content).toBe("answer");
		// assistant-last → current "continue"
		expect(userMsg(state.currentMessage).content).toBe("continue");
	});

	it("9. thinking sin signature → reasoningContent sin la key", () => {
		const state = buildConversationState(
			asContext({
				messages: [
					{ role: "user", content: "think", timestamp: 1 },
					{
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "no sig" },
							{ type: "text", text: "answer" },
						],
						timestamp: 2,
					},
				],
			}),
			OPTS,
		);
		const reasoning = assistantMsg(state.history[1]!).reasoningContent;
		expect(reasoning).toEqual({ text: "no sig" });
		expect(Object.prototype.hasOwnProperty.call(reasoning ?? {}, "signature")).toBe(false);
	});

	it("10. conversación mínima (un user, sin systemPrompt ni tools) → history vacía, current user", () => {
		const state = buildConversationState(
			asContext({ messages: [{ role: "user", content: "hello", timestamp: 1 }] }),
			OPTS,
		);
		expect(state.history.length).toBe(0);
		const current = userMsg(state.currentMessage);
		expect(current.content).toBe("hello");
		expect(current.userInputMessageContext).toBeUndefined();
		expect(state.conversationId).toBe("conv-1");
		expect(state.chatTriggerType).toBe("MANUAL");
	});

	it("11. tools vacíos ([] ) → userInputMessageContext undefined", () => {
		const state = buildConversationState(
			asContext({
				messages: [{ role: "user", content: "x", timestamp: 1 }],
				tools: [],
			}),
			OPTS,
		);
		expect(userMsg(state.currentMessage).userInputMessageContext).toBeUndefined();
	});

	it("12. toolResult con content vacío → placeholder \"(empty tool result)\"", () => {
		const state = buildConversationState(
			asContext({
				messages: [
					{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "t", arguments: {} }], timestamp: 1 },
					{ role: "toolResult", content: "", toolCallId: "c1", timestamp: 2 },
				],
			}),
			OPTS,
		);
		expect(toolResults(state.currentMessage)[0]!.content).toEqual([{ text: "(empty tool result)" }]);
	});

	it("13. origin por defecto IDE y overridable", () => {
		const state = buildConversationState(
			asContext({ messages: [{ role: "user", content: "x", timestamp: 1 }] }),
			{ ...OPTS, origin: "CLI" },
		);
		expect(userMsg(state.currentMessage).origin).toBe("CLI");
	});

	it("14. user con content en blocks (array) → texto aplanado con \\n", () => {
		const state = buildConversationState(
			asContext({
				messages: [
					{ role: "user", content: [{ type: "text", text: "line1" }, { type: "text", text: "line2" }], timestamp: 1 },
				],
			}),
			OPTS,
		);
		expect(userMsg(state.currentMessage).content).toBe("line1\nline2");
	});

	it("15. developer message → user message; se mergea con el user adyacente", () => {
		const state = buildConversationState(
			asContext({
				systemPrompt: ["sys"],
				messages: [
					{ role: "user", content: "hi", timestamp: 1 },
					{ role: "developer", content: "extra guidance", timestamp: 2 },
					{ role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 3 },
				],
			}),
			OPTS,
		);
		// history: [user(system + "hi" + "extra guidance" mergeados), assistant]
		expect(state.history.length).toBe(2);
		expect(userMsg(state.history[0]!).content).toBe(
			"[SYSTEM INSTRUCTIONS]\nsys\n[END SYSTEM INSTRUCTIONS]\nhi\nextra guidance",
		);
	});

	it("16. toolCall sin arguments → input {}", () => {
		const state = buildConversationState(
			asContext({
				messages: [
					{ role: "assistant", content: [{ type: "toolCall", id: "c2", name: "noArgs" }], timestamp: 1 },
					{ role: "toolResult", content: "done", toolCallId: "c2", timestamp: 2 },
				],
			}),
			OPTS,
		);
		expect(assistantMsg(state.history[0]!).toolUses?.[0]!.input).toEqual({});
	});

	it("17. toolResult a mitad de transcript (sigue assistant) → user sintetizado con esos toolResults", () => {
		const state = buildConversationState(
			asContext({
				messages: [
					{ role: "user", content: "start", timestamp: 1 },
					{
						role: "assistant",
						content: [{ type: "toolCall", id: "mid-1", name: "get_weather", arguments: { city: "Nice" } }],
						timestamp: 2,
					},
					{ role: "toolResult", content: "Nice 20C", toolCallId: "mid-1", timestamp: 3 },
					{ role: "assistant", content: [{ type: "text", text: "answer" }], timestamp: 4 },
				],
				tools: TOOLS,
			}),
			OPTS,
		);
		// history: [user start, assistant(toolUse), user vacío sintetizado con toolResults, assistant answer]
		expect(state.history.length).toBe(4);
		const synth = state.history[2]!;
		expect(userMsg(synth).content).toBe("");
		const results = toolResults(synth);
		expect(results.length).toBe(1);
		expect(results[0]!.toolUseId).toBe("mid-1");
		expect(results[0]!.content).toEqual([{ text: "Nice 20C" }]);
		expect(results[0]!.status).toBe("success");
		// alternancia preservada alrededor del sintetizado
		expect(state.history[1]!.assistantResponseMessage).toBeDefined();
		expect(state.history[3]!.assistantResponseMessage).toBeDefined();
		// last = assistant → continue, MANUAL
		expect(userMsg(state.currentMessage).content).toBe("continue");
		expect(state.chatTriggerType).toBe("MANUAL");
	});

	it("18. alternancia global: nunca dos user ni dos assistant adyacentes en history", () => {
		const state = buildConversationState(
			asContext({
				systemPrompt: ["sys"],
				messages: [
					{ role: "user", content: "a", timestamp: 1 },
					{ role: "user", content: "b", timestamp: 2 },
					{
						role: "assistant",
						content: [
							{ type: "text", text: "r1" },
							{ type: "toolCall", id: "z1", name: "t", arguments: {} },
							{ type: "toolCall", id: "z2", name: "t", arguments: {} },
						],
						timestamp: 3,
					},
					{ role: "toolResult", content: "z1-res", toolCallId: "z1", timestamp: 4 },
					{ role: "toolResult", content: "z2-res", toolCallId: "z2", timestamp: 5 },
					{ role: "user", content: "c", timestamp: 6 },
					{ role: "assistant", content: [{ type: "text", text: "r2" }], timestamp: 7 },
					{ role: "user", content: "final", timestamp: 8 },
				],
				tools: TOOLS,
			}),
			OPTS,
		);
		// history: [user(system+a+b mergeados), assistant r1(toolUses z1,z2),
		//           user("c" + toolResults z1+z2), assistant r2]; current: user "final"
		const kinds = state.history.map(h => (h.userInputMessage ? "U" : "A"));
		for (let i = 1; i < kinds.length; i++) {
			expect(kinds[i]).not.toBe(kinds[i - 1]);
		}
		// el user intermedio queda con el texto "c" y ambos toolResults (merge de user c en el sintetizado)
		const middle = state.history[2]!;
		expect(userMsg(middle).content).toBe("c");
		expect(toolResults(middle).map(r => r.toolUseId)).toEqual(["z1", "z2"]);
		// alternancia contra current: history termina en assistant y current es user
		expect(state.history[state.history.length - 1]!.assistantResponseMessage).toBeDefined();
		// current = último user, turno nuevo
		expect(userMsg(state.currentMessage).content).toBe("final");
		expect(state.chatTriggerType).toBe("MANUAL");
	});
});
