/**
 * Integration: real dispatch through the Kiro runtime endpoint.
 *
 * Two layers, per the live-integration task:
 *  1. client-level — src/token.ts + src/client.ts + src/conversation.ts
 *     against runtime.{region}.kiro.dev (aísla la capa HTTP del host omp).
 *  2. CLI smoke — `omp -p --model kiro/claude-haiku-4.5` end-to-end.
 *
 * Skips (not fails) when no kiro-cli credential exists on this host. A short
 * single run per layer: consumes KIRO PRO credits (see task note).
 */
import { describe, expect, it } from "bun:test";
import { generateAssistantResponse } from "../../src/client";
import { buildConversationState } from "../../src/conversation";
import { getKiroCredential, type KiroCredential } from "../../src/token";

const MODEL = "claude-haiku-4.5";
const PROFILE_ARN = process.env.KIRO_PROFILE_ARN ?? "";

async function credentialOrNull(): Promise<KiroCredential | null> {
	try {
		return await getKiroCredential();
	} catch {
		return null;
	}
}

describe("kiro integration dispatch", () => {
	it(
		"client-level: GenerateAssistantResponse returns model text via live endpoint",
		async () => {
			const credential = await credentialOrNull();
			if (!credential || !PROFILE_ARN) {
				console.warn("skip: no kiro-cli credential or KIRO_PROFILE_ARN (login/env required)");
				return;
			}
			const conversationState = buildConversationState(
				{ messages: [{ role: "user", content: "Reply with exactly: ok", timestamp: Date.now() }] },
				{ modelId: MODEL, conversationId: crypto.randomUUID(), origin: "IDE" },
			);
			const events = await generateAssistantResponse({
				accessToken: credential.accessToken,
				region: credential.region,
				profileArn: PROFILE_ARN,
				conversationState,
			});
			expect(events.length).toBeGreaterThan(0);
			let text = "";
			let sawMetadata = false;
			for (const event of events) {
				if (event.type === "assistantResponseEvent") {
					const content = event.data["content"];
					if (typeof content === "string") text += content;
				} else if (event.type === "metadataEvent") {
					sawMetadata = true;
					expect(typeof event.data["stopReason"]).toBe("string");
				}
			}
			expect(sawMetadata).toBe(true);
			expect(text.trim()).toBe("ok");
		},
		{ timeout: 60_000 },
	);

	it(
		"CLI smoke: omp -p --model kiro/claude-haiku-4.5 returns the model's reply",
		async () => {
			// Headless smoke of the installed extension (~/.omp/agent/extensions/kiro.ts
		// symlink → src/index.ts). Skipped when omp is not on PATH.
			if (!process.env.PATH?.split(":").some(dir => exists(`${dir}/omp`))) {
				console.warn("skip: omp not on PATH");
				return;
			}
			const proc = Bun.spawn(["omp", "-p", "--model", `kiro/${MODEL}`, "Reply with exactly: ok"], {
				cwd: process.cwd(),
				stdout: "pipe",
				stderr: "pipe",
			});
			const stdout = await new Response(proc.stdout).text();
			const stderr = await new Response(proc.stderr).text();
			const code = await proc.exited;
			expect(stderr).not.toContain("error");
			const reply = stdout.replace(/^Working\.\.\.\s*/m, "").trim();
			expect(code).toBe(0);
			expect(reply).toBe("ok");
		},
		{ timeout: 120_000 },
	);
});

function exists(path: string): boolean {
	try {
		require("node:fs").accessSync(path);
		return true;
	} catch {
		return false;
	}
}
