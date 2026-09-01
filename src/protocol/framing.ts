import type { ProtocolMessage } from "./messages.ts";

export const MAX_FRAME_BYTES = 65_536;

export class FramingError extends Error {}

export function encodeFrame(message: ProtocolMessage): Buffer {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  if (payload.length === 0 || payload.length > MAX_FRAME_BYTES) {
    throw new FramingError(`frame payload length ${payload.length} is invalid`);
  }

  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

export class FrameDecoder {
  private buffer = Buffer.alloc(0);
  private failed = false;

  push(chunk: Buffer): unknown[] {
    if (this.failed) {
      throw new FramingError("decoder is failed");
    }

    this.buffer = Buffer.concat([this.buffer, chunk]);
    const values: unknown[] = [];

    try {
      while (this.buffer.length >= 4) {
        const length = this.buffer.readUInt32BE(0);
        if (length === 0 || length > MAX_FRAME_BYTES) {
          throw new FramingError(`frame payload length ${length} is invalid`);
        }
        if (this.buffer.length < 4 + length) {
          break;
        }

        const payload = this.buffer.subarray(4, 4 + length);
        this.buffer = this.buffer.subarray(4 + length);

        try {
          values.push(JSON.parse(payload.toString("utf8")));
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new FramingError(`invalid JSON: ${reason}`);
        }
      }

      return values;
    } catch (error) {
      this.failed = true;
      throw error;
    }
  }
}
