import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import channelAdapter from "../src/index.ts";

type EventName = "session_start" | "session_shutdown";
type Handler = (event: { type: EventName }, context: FakeContext) => void | Promise<void>;
type Command = { handler(args: string, context: FakeContext): void | Promise<void> };
type Notification = { message: string; type: "info" | "warning" | "error" | undefined };
type FakeContext = {
	isIdle(): boolean;
	ui: { notify(message: string, type?: Notification["type"]): void };
};

const roots: string[] = [];
const originalEnv = {
	sendDir: process.env.A4S_CHANNEL_SEND_DIR,
	receiveDir: process.env.A4S_CHANNEL_RECEIVE_DIR,
	address: process.env.A4S_CHANNEL_ADDRESS,
};

afterEach(async () => {
	setEnv("A4S_CHANNEL_SEND_DIR", originalEnv.sendDir);
	setEnv("A4S_CHANNEL_RECEIVE_DIR", originalEnv.receiveDir);
	setEnv("A4S_CHANNEL_ADDRESS", originalEnv.address);
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("sends and receives canonical messages through emulated bus directories", async () => {
	const harness = await createHarness();
	await harness.start();

	await harness.command("channel-send", "claude Review this change");
	const sentNames = await readdir(harness.sendDir);
	assert.equal(sentNames.length, 1);
	assert.equal(sentNames[0]?.endsWith(".json"), true);
	const sent = JSON.parse(await readFile(join(harness.sendDir, sentNames[0] as string), "utf8")) as Record<string, unknown>;
	assert.deepEqual(
		{ from: sent.from, to: sent.to, kind: sent.kind, body: sent.body, reply_to: sent.reply_to },
		{ from: "pi:test", to: "claude", kind: "prompt", body: "Review this change", reply_to: "pi:test" },
	);
	assert.equal(typeof sent.id, "string");
	assert.equal(typeof sent.ts, "number");

	await writeFile(join(harness.receiveDir, "a-invalid.json"), "{", "utf8");
	await writeMessage(harness.receiveDir, message({ id: "ignored", to: "other" }));
	await writeMessage(harness.receiveDir, message({ id: "incoming", to: "pi:test" }));
	await waitFor(() => harness.received.length === 1 && harness.notifications.some(({ type }) => type === "error"));
	assert.deepEqual(harness.received, [
		{
			text: "Channel message from claude (notify, incoming):\nDone",
			options: undefined,
		},
	]);
	assert.match(harness.notifications.find(({ type }) => type === "error")?.message ?? "", /a-invalid\.json/);

	await harness.shutdown();
	await harness.shutdown();
	await writeMessage(harness.receiveDir, message({ id: "late", to: "pi:test" }));
	await new Promise((resolve) => setTimeout(resolve, 75));
	assert.equal(harness.received.length, 1);
});

test("queues inbound messages as follow-ups while Pi is busy", async () => {
	const harness = await createHarness(false);
	await harness.start();
	await writeMessage(harness.receiveDir, message({ id: "busy", to: "pi:test" }));
	await waitFor(() => harness.received.length === 1);
	assert.deepEqual(harness.received[0]?.options, { deliverAs: "followUp" });
	await harness.shutdown();
});

async function createHarness(idle = true) {
	const root = await mkdtemp(join(tmpdir(), "a4s-channel-adapter-"));
	roots.push(root);
	const sendDir = join(root, "send");
	const receiveDir = join(root, "receive");
	process.env.A4S_CHANNEL_SEND_DIR = sendDir;
	process.env.A4S_CHANNEL_RECEIVE_DIR = receiveDir;
	process.env.A4S_CHANNEL_ADDRESS = "pi:test";

	const events = new Map<EventName, Handler>();
	const commands = new Map<string, Command>();
	const received: Array<{ text: string; options: { deliverAs: "followUp" } | undefined }> = [];
	const notifications: Notification[] = [];
	const context: FakeContext = {
		isIdle: () => idle,
		ui: { notify: (message, type) => notifications.push({ message, type }) },
	};
	const api = {
		on(event: EventName, handler: Handler) {
			events.set(event, handler);
			return () => {};
		},
		registerCommand(name: string, command: Command) {
			commands.set(name, command);
		},
		async sendUserMessage(text: string, options?: { deliverAs: "followUp" }) {
			received.push({ text, options });
		},
	};
	channelAdapter(api as never);

	return {
		sendDir,
		receiveDir,
		received,
		notifications,
		async start() {
			const handler = events.get("session_start");
			assert.ok(handler);
			await handler({ type: "session_start" }, context);
		},
		async shutdown() {
			const handler = events.get("session_shutdown");
			assert.ok(handler);
			await handler({ type: "session_shutdown" }, context);
		},
		async command(name: string, args: string) {
			const command = commands.get(name);
			assert.ok(command);
			await command.handler(args, context);
		},
	};
}

function message(overrides: { id: string; to: string }) {
	return {
		id: overrides.id,
		from: "claude",
		to: overrides.to,
		kind: "notify",
		body: "Done",
		reply_to: "claude",
		ts: 1000,
	};
}

async function writeMessage(directory: string, value: ReturnType<typeof message>): Promise<void> {
	await writeFile(join(directory, `${value.id}.json`), `${JSON.stringify(value)}\n`, "utf8");
}

function setEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

async function waitFor(condition: () => boolean): Promise<void> {
	const deadline = Date.now() + 1_000;
	while (!condition()) {
		if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
