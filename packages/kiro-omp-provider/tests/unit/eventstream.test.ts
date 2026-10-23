import { describe, expect, it } from "bun:test";
import { AwsEventStreamDecoder, decodeEventStream } from "../../src/eventstream";
import { readFileSync } from "node:fs";

function fixture(name: string): Uint8Array {
	return new Uint8Array(readFileSync(`${import.meta.dir}/../fixtures/${name}`));
}

describe("eventstream decoder", () => {
	it("decodes a complete text response from a live capture", async () => {
		const events = decodeEventStream(await fixture("text-response.bin"));
		expect(events.length).toBe(2);
		expect(events[0]?.type).toBe("assistantResponseEvent");
		const payload = JSON.parse(new TextDecoder().decode(events[0]!.payload));
		expect(payload.content).toBe("ok");
		expect(payload.modelId).toBe("claude-haiku-4.5");
		expect(events[1]?.type).toBe("metadataEvent");
		const meta = JSON.parse(new TextDecoder().decode(events[1]!.payload));
		expect(meta.stopReason).toBe("END_TURN");
	});

	it("decodes a multi-chunk streaming response (34 deltas)", async () => {
		const events = decodeEventStream(await fixture("multi-chunk-response.bin"));
		const deltas = events.filter(e => e.type === "assistantResponseEvent");
		expect(deltas.length).toBe(34);
		const text = deltas
			.map(e => JSON.parse(new TextDecoder().decode(e.payload)).content as string)
			.join("");
		expect(text).toContain("data type that consists of a set of named constant values");
	});

	it("decodes tool-use events including arg chunks and stop", async () => {
		const events = decodeEventStream(await fixture("tool-response.bin"));
		const toolEvents = events.filter(e => e.type === "toolUseEvent");
		expect(toolEvents.length).toBe(5);
		const payloads = toolEvents.map(e => JSON.parse(new TextDecoder().decode(e.payload)));
		expect(payloads[0]?.name).toBe("get_weather");
		const args = payloads
			.slice(1, 4)
			.map(p => p.input as string)
			.join("");
		expect(JSON.parse(args)).toEqual({ city: "Paris" });
		expect(payloads[4]?.stop).toBe(true);
		const meta = events.find(e => e.type === "metadataEvent");
		expect(JSON.parse(new TextDecoder().decode(meta!.payload)).stopReason).toBe("TOOL_USE");
	});

	it("handles frames split across chunks (incremental feed)", async () => {
		const body = await fixture("text-response.bin");
		const decoder = new AwsEventStreamDecoder();
		const half = Math.floor(body.length / 2);
		const first = decoder.push(body.subarray(0, half));
		const second = decoder.push(body.subarray(half));
		expect(first.length + second.length).toBe(2);
		expect(second[1]?.type ?? first[0]?.type).toBeDefined();
	});

	it("rejects invalid frame lengths", () => {
		const decoder = new AwsEventStreamDecoder();
		const garbage = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 8, 1, 2, 3, 4, 5, 6, 7, 8]);
		// totalLen=0 is invalid (< 16)
		expect(() => decoder.push(garbage)).toThrow(/invalid frame length/);
	});

	it("reports pending bytes for incomplete frames", () => {
		const decoder = new AwsEventStreamDecoder();
		decoder.push(new Uint8Array([0, 0, 0, 100]));
		expect(decoder.pending).toBe(4);
	});
});
