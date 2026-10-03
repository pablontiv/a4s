import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const POLL_MS = 25;
const KINDS = new Set(["prompt", "steer", "result", "notify", "ack"]);

type CanonicalMessage = {
	id: string;
	from: string;
	to: string;
	kind: string;
	body: string;
	reply_to?: string;
	ts: string | number;
};

type PullResult = {
	messages: CanonicalMessage[];
	errors: string[];
};

type DirectoryBus = {
	publish(to: string, body: string): Promise<CanonicalMessage>;
	pull(to: string): Promise<PullResult>;
};

export default function channelAdapter(pi: ExtensionAPI): void {
	let bus: DirectoryBus | undefined;
	let timer: NodeJS.Timeout | undefined;
	let pendingPoll: Promise<void> | undefined;

	pi.registerCommand("channel-send", {
		description: "Send a prompt through the emulated message bus",
		handler: async (args, ctx) => {
			const input = args.trim();
			const separator = input.indexOf(" ");
			if (separator < 1 || !input.slice(separator + 1).trim()) {
				ctx.ui.notify("Usage: /channel-send <to> <body>", "warning");
				return;
			}
			if (!bus) throw new Error("Channel adapter session is not started");

			const message = await bus.publish(input.slice(0, separator), input.slice(separator + 1).trim());
			ctx.ui.notify(`Channel message sent: ${message.id}`, "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await stop();
		const sendDir = process.env.A4S_CHANNEL_SEND_DIR;
		const receiveDir = process.env.A4S_CHANNEL_RECEIVE_DIR;
		const address = process.env.A4S_CHANNEL_ADDRESS;
		if (!sendDir || !receiveDir || !address) {
			throw new Error(
				"Channel adapter requires A4S_CHANNEL_SEND_DIR, A4S_CHANNEL_RECEIVE_DIR, and A4S_CHANNEL_ADDRESS",
			);
		}

		const activeBus = await createDirectoryBus(sendDir, receiveDir, address);
		bus = activeBus;
		const poll = (): void => {
			if (pendingPoll || bus !== activeBus) return;
			pendingPoll = activeBus.pull(address)
				.then(async ({ messages, errors }) => {
					if (bus !== activeBus) return;
					for (const error of errors) ctx.ui.notify(`Channel receive failed: ${error}`, "error");
					for (const message of messages) {
						const text = `Channel message from ${message.from} (${message.kind}, ${message.id}):\n${message.body}`;
						if (ctx.isIdle()) await Promise.resolve(pi.sendUserMessage(text));
						else await Promise.resolve(pi.sendUserMessage(text, { deliverAs: "followUp" }));
					}
				})
				.catch((error: unknown) => {
					ctx.ui.notify(`Channel receive failed: ${error instanceof Error ? error.message : String(error)}`, "error");
				})
				.finally(() => {
					pendingPoll = undefined;
				});
		};
		poll();
		timer = setInterval(poll, POLL_MS);
	});

	pi.on("session_shutdown", stop);

	async function stop(): Promise<void> {
		bus = undefined;
		if (timer) clearInterval(timer);
		timer = undefined;
		await pendingPoll;
		pendingPoll = undefined;
	}
}

async function createDirectoryBus(sendDir: string, receiveDir: string, from: string): Promise<DirectoryBus> {
	await Promise.all([mkdir(sendDir, { recursive: true }), mkdir(receiveDir, { recursive: true })]);
	const seen = new Set<string>();

	return {
		async publish(to, body) {
			const id = randomUUID();
			const message: CanonicalMessage = {
				id,
				from,
				to,
				kind: "prompt",
				body,
				reply_to: from,
				ts: Date.now(),
			};
			const temporary = join(sendDir, `.${id}.tmp`);
			await writeFile(temporary, `${JSON.stringify(message, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
			await rename(temporary, join(sendDir, `${id}.json`));
			return message;
		},
		async pull(to) {
			// ponytail: directory scans are enough for the PoC; use a bus cursor when retention grows.
			const entries = await readdir(receiveDir);
			const names = entries
				.filter((name) => name.endsWith(".json") && !seen.has(name))
				.sort((left, right) => left.localeCompare(right));
			const result: PullResult = { messages: [], errors: [] };
			for (const name of names) {
				seen.add(name);
				try {
					const message = parseCanonicalMessage(await readFile(join(receiveDir, name), "utf8"));
					if (message.to === to) result.messages.push(message);
				} catch (error: unknown) {
					result.errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			return result;
		},
	};
}

function parseCanonicalMessage(text: string): CanonicalMessage {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error("message must be valid JSON");
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("message must be an object");
	const message = value as Record<string, unknown>;
	for (const field of ["id", "from", "to", "kind", "body"] as const) {
		if (typeof message[field] !== "string" || (field !== "body" && !message[field])) {
			throw new Error(`message.${field} must be a ${field === "body" ? "string" : "non-empty string"}`);
		}
	}
	if (!KINDS.has(message.kind as string)) throw new Error("message.kind is not supported");
	if (
		(typeof message.ts !== "string" || !message.ts)
		&& (typeof message.ts !== "number" || !Number.isFinite(message.ts))
	) {
		throw new Error("message.ts must be a non-empty string or finite number");
	}
	if (message.reply_to !== undefined && (typeof message.reply_to !== "string" || !message.reply_to)) {
		throw new Error("message.reply_to must be a non-empty string");
	}
	return message as CanonicalMessage;
}
