/**
 * AWS Event Stream decoder (content-type: application/vnd.amazon.eventstream).
 *
 * Frame layout (all big-endian):
 *   u32 totalLength | u32 headersLength | u32 preludeCrc | u32 payloadCrc(=last 4 bytes)
 *   headers: sequence of (u8 nameLen, name, u8 valueType, value)
 *     valueType 7 = string (u16 len + bytes) | 8 = timestamp | 9 = uuid (16 bytes)
 *     2 = i8, 4 = i32, 5 = u32(?) per spec i32; 6 = i64, 1 = bool, 3 = f64
 *   payload: JSON for this service.
 *
 * Synchronous and incremental: feed chunks, drain complete events. The omp
 * streamSimple contract requires us to never block the caller's event loop
 * between fetch chunks.
 */

export interface AwsEventStreamEvent {
	/** Value of the `:event-type` header, when present. */
	type?: string;
	/** Value of the `:message-type` header, when present. */
	messageType?: string;
	/** Raw payload bytes (JSON for this service; empty when none). */
	payload: Uint8Array;
	/** All decoded headers, keyed by name. */
	headers: Record<string, string | number | bigint | boolean>;
}

const HEADER_VALUE_PARSERS: Record<number, (view: DataView, buf: Uint8Array, offset: number) => { value: string | number | bigint | boolean; size: number }> = {
	1: (_view, _buf, offset) => ({ value: _buf[offset] !== 0, size: 1 }), // bool
	2: (view, _buf, _offset) => ({ value: view.getInt8(view.byteOffset + _offset), size: 1 }), // i8
	3: (view, _buf, offset) => ({ value: view.getFloat64(view.byteOffset + offset), size: 8 }), // f64 (returned as number; typed as never)
	4: (view, _buf, offset) => ({ value: view.getInt32(view.byteOffset + offset), size: 4 }), // i32
	5: (view, _buf, offset) => ({ value: view.getUint32(view.byteOffset + offset), size: 4 }), // u32-ish
	6: (view, _buf, offset) => ({ value: view.getBigInt64(view.byteOffset + offset), size: 8 }), // i64
	7: (view, buf, offset) => {
		// string: u16 length + bytes
		const len = view.getUint16(view.byteOffset + offset);
		return { value: new TextDecoder().decode(buf.subarray(offset + 2, offset + 2 + len)), size: 2 + len };
	},
	8: (view, _buf, offset) => ({ value: view.getBigInt64(view.byteOffset + offset), size: 8 }), // timestamp
	9: (_view, buf, offset) => {
		// uuid: 16 raw bytes; hex-encode for display
		const hex = Array.from(buf.subarray(offset, offset + 16), b => b.toString(16).padStart(2, "0")).join("");
		return { value: hex, size: 16 };
	},
};

export class AwsEventStreamDecoder {
	#buffer = new Uint8Array(0);
	#text = new TextDecoder();

	/** Feed a raw chunk; returns every event whose frame is now complete. */
	push(chunk: Uint8Array): AwsEventStreamEvent[] {
		const merged = new Uint8Array(this.#buffer.length + chunk.length);
		merged.set(this.#buffer, 0);
		merged.set(chunk, this.#buffer.length);
		this.#buffer = merged;

		const events: AwsEventStreamEvent[] = [];
		let offset = 0;
		const buf = this.#buffer;
		const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

		while (offset + 12 <= buf.length) {
			const totalLen = view.getUint32(offset);
			const headersLen = view.getUint32(offset + 4);
			if (totalLen < 16 || totalLen > 64 * 1024 * 1024) {
				throw new Error(`kiro eventstream: invalid frame length ${totalLen} at offset ${offset}`);
			}
			if (offset + totalLen > buf.length) break; // incomplete frame; wait for more

			const headers: Record<string, string | number | bigint | boolean> = {};
			let h = offset + 12;
			const hEnd = offset + 12 + headersLen;
			while (h < hEnd) {
				const nameLen = buf[h];
				h += 1;
				const name = this.#text.decode(buf.subarray(h, h + nameLen));
				h += nameLen;
				const valueType = buf[h];
				h += 1;
				const parser = HEADER_VALUE_PARSERS[valueType];
				if (!parser) throw new Error(`kiro eventstream: unknown header value type ${valueType}`);
				const { value, size } = parser(view, buf, h);
				h += size;
				headers[name] = value;
			}

			const payload = buf.subarray(hEnd, offset + totalLen - 4);
			events.push({
				type: typeof headers[":event-type"] === "string" ? headers[":event-type"] : undefined,
				messageType: typeof headers[":message-type"] === "string" ? headers[":message-type"] : undefined,
				payload,
				headers,
			});
			offset += totalLen;
		}
		this.#buffer = buf.subarray(offset);
		return events;
	}

	/** Bytes buffered awaiting completion (diagnostics only). */
	get pending(): number {
		return this.#buffer.length;
	}
}

/** Decode a complete response body in one call. */
export function decodeEventStream(body: Uint8Array): AwsEventStreamEvent[] {
	const decoder = new AwsEventStreamDecoder();
	const events = decoder.push(body);
	if (decoder.pending > 0) {
		throw new Error(`kiro eventstream: trailing ${decoder.pending} bytes after final frame`);
	}
	return events;
}
