/**
 * PoC: one-shot chat against Kiro GenerateAssistantResponse using the repo's
 * own modules (token + conversation + client + eventstream). No omp involved —
 * proves the capability end to end from this codebase.
 *
 * Usage: bun run scripts/poc-chat.ts [--model M] [--effort E] "prompt"
 */
import { generateAssistantResponse } from "../src/client";
import { buildConversationState } from "../src/conversation";
import { getKiroCredential, getKiroProfileArn } from "../src/token";

const PROFILE_ARN = getKiroProfileArn();

const args = process.argv.slice(2);
let model = "claude-haiku-4.5";
let effort: string | undefined;
const promptParts: string[] = [];
for (let i = 0; i < args.length; i++) {
	if (args[i] === "--model") model = args[++i] ?? model;
	else if (args[i] === "--effort") effort = args[++i];
	else promptParts.push(args[i]!);
}
const prompt = promptParts.join(" ").trim();
if (!prompt) {
	console.error("usage: bun run scripts/poc-chat.ts [--model M] [--effort E] \"prompt\"");
	process.exit(2);
}

const credential = await getKiroCredential();
const conversationState = buildConversationState(
	{
		messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
	},
	{ modelId: model, conversationId: crypto.randomUUID(), origin: "IDE" },
);

const events = await generateAssistantResponse({
	accessToken: credential.accessToken,
	region: credential.region,
	profileArn: PROFILE_ARN,
	conversationState,
	...(effort ? { additionalModelRequestFields: { output_config: { effort } } } : {}),
});

let text = "";
let reasoning = "";
const toolUses: { id: string; name: string; raw: string }[] = [];
let current: { id: string; name: string; raw: string } | null = null;
let stopReason = "";
let usageJson = "";

for (const event of events) {
	if (event.type === "assistantResponseEvent") {
		const content = event.data["content"];
		if (typeof content === "string") text += content;
	} else if (event.type === "reasoningContentEvent") {
		const rc = event.data["reasoningContent"];
		if (rc && typeof rc === "object" && "text" in rc && typeof rc.text === "string") reasoning += rc.text;
	} else if (event.type === "toolUseEvent") {
		const id = event.data["toolUseId"];
		const name = event.data["name"];
		if (typeof id === "string" && typeof name === "string" && (!current || current.id !== id)) {
			current = { id, name, raw: "" };
			toolUses.push(current);
		}
		const chunk = event.data["input"];
		if (typeof chunk === "string" && current) current.raw += chunk;
	} else if (event.type === "metadataEvent") {
		stopReason = typeof event.data["stopReason"] === "string" ? event.data["stopReason"] : "";
		const tu = event.data["tokenUsage"];
		if (tu && typeof tu === "object") usageJson = JSON.stringify(tu);
	}
}

console.log(`model=${model} events=${events.length} stop=${stopReason}`);
if (reasoning) console.log(`--- reasoning (${reasoning.length} chars) ---\n${reasoning.slice(0, 400)}`);
for (const t of toolUses) console.log(`--- toolUse ${t.name}(${t.id}) args=${t.raw}`);
console.log(`--- text ---\n${text}`);
if (usageJson) console.log(`--- usage ---\n${usageJson}`);
