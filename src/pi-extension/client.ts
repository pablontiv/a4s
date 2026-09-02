import { once } from "node:events";
import { Socket, createConnection } from "node:net";
import { encodeFrame, FrameDecoder, FramingError } from "../protocol/framing.ts";
import {
  createAck,
  createMessageId,
  parseMessage,
  ProtocolError,
  type AttachMessage,
  type AttachPayload,
  type DeliveryMessage,
  type ProtocolMessage,
} from "../protocol/messages.ts";

export interface ClientEvent {
  component: "pi-extension";
  event: string;
  message_id?: string;
  delivery_id?: string;
  detail?: string;
}

export interface E0PiClientOptions {
  endpoint: string;
  attach: AttachPayload;
  reconnectDelaysMs?: readonly number[];
  onEvent(event: ClientEvent): void;
}

interface ActiveConnection {
  socket: Socket;
  decoder: FrameDecoder;
  attached: boolean;
  attachMessageId?: string;
  reconnectScheduled: boolean;
}

const DEFAULT_RECONNECT_DELAYS_MS = [100, 250, 500, 1_000] as const;

export class E0PiClient {
  private readonly reconnectDelaysMs: readonly number[];
  private readonly seenDeliveryIds = new Set<string>();
  private connection: ActiveConnection | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reconnectAttempt = 0;
  private stopped = true;
  private firstAttachPromise: Promise<void> | undefined;
  private resolveFirstAttach: (() => void) | undefined;
  private rejectFirstAttach: ((error: Error) => void) | undefined;

  constructor(private readonly options: E0PiClientOptions) {
    this.reconnectDelaysMs = options.reconnectDelaysMs?.length
      ? [...options.reconnectDelaysMs]
      : DEFAULT_RECONNECT_DELAYS_MS;
  }

  start(): Promise<void> {
    if (!this.stopped) {
      return this.firstAttachPromise ?? Promise.resolve();
    }

    this.stopped = false;
    this.firstAttachPromise = new Promise((resolve, reject) => {
      this.resolveFirstAttach = resolve;
      this.rejectFirstAttach = reject;
    });
    this.connect();
    return this.firstAttachPromise;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearReconnectTimer();

    const socket = this.connection?.socket;
    this.connection = undefined;
    this.resolveFirstAttach = undefined;
    this.rejectFirstAttach = undefined;
    this.firstAttachPromise = undefined;

    if (!socket || socket.closed || socket.destroyed) return;

    const closed = once(socket, "close").then(() => undefined, () => undefined);
    socket.destroy();
    await closed;
  }

  private connect(): void {
    if (this.stopped || this.connection) return;

    this.emit({ event: "connecting", detail: this.options.endpoint });
    const socket = createConnection(this.options.endpoint);
    const connection: ActiveConnection = {
      socket,
      decoder: new FrameDecoder(),
      attached: false,
      reconnectScheduled: false,
    };
    this.connection = connection;

    socket.once("connect", () => {
      if (this.stopped || this.connection !== connection) return;
      this.emit({ event: "connected" });
      this.sendAttach(connection);
    });

    socket.on("data", (chunk: Buffer) => this.handleData(connection, chunk));

    socket.once("error", (error) => {
      this.emit({ event: "error", detail: error.message });
    });

    socket.once("close", () => {
      const wasAttached = connection.attached;
      if (this.connection === connection) {
        this.connection = undefined;
      }
      this.emit({ event: "disconnected", detail: wasAttached ? "attached" : "unattached" });
      this.scheduleReconnect(connection);
    });
  }

  private sendAttach(connection: ActiveConnection): void {
    const message: AttachMessage = {
      protocol_version: 1,
      message_id: createMessageId(),
      type: "attach",
      payload: this.options.attach,
    };
    connection.attachMessageId = message.message_id;
    connection.socket.write(encodeFrame(message));
    this.emit({ event: "attach_sent", message_id: message.message_id });
  }

  private handleData(connection: ActiveConnection, chunk: Buffer): void {
    if (this.stopped || this.connection !== connection) return;

    let values: unknown[];
    try {
      values = connection.decoder.push(chunk);
    } catch (error) {
      this.handleInvalidServerFrame(connection, error);
      return;
    }

    for (const value of values) {
      if (this.stopped || this.connection !== connection) return;
      let message: ProtocolMessage;
      try {
        message = parseMessage(value);
      } catch (error) {
        this.handleInvalidServerFrame(connection, error);
        return;
      }
      this.handleMessage(connection, message);
    }
  }

  private handleMessage(connection: ActiveConnection, message: ProtocolMessage): void {
    this.emit({ event: "message_received", message_id: message.message_id, detail: message.type });

    if (!connection.attached) {
      if (message.type === "attached") {
        if (
          message.payload.in_reply_to !== connection.attachMessageId
          || message.payload.owner_id !== this.options.attach.owner_id
          || message.payload.binding_revision !== this.options.attach.binding_revision
        ) {
          this.failBeforeAttach(new Error("attached response does not match attach request"), connection);
          return;
        }
        connection.attached = true;
        this.reconnectAttempt = 0;
        this.emit({ event: "attached", message_id: message.message_id });
        this.resolveFirstAttach?.();
        this.resolveFirstAttach = undefined;
        this.rejectFirstAttach = undefined;
        return;
      }

      this.failBeforeAttach(new Error(`unexpected ${message.type} before attached`), connection);
      return;
    }

    switch (message.type) {
      case "delivery":
        this.handleDelivery(connection, message);
        return;
      case "error":
        this.emit({ event: "error", message_id: message.message_id, detail: `${message.payload.code}: ${message.payload.message}` });
        return;
      case "attached":
        this.emit({ event: "error", message_id: message.message_id, detail: "duplicate attached message" });
        return;
      default:
        this.emit({ event: "error", message_id: message.message_id, detail: `unexpected server message ${message.type}` });
    }
  }

  private handleDelivery(connection: ActiveConnection, message: DeliveryMessage): void {
    if (message.payload.owner_id !== this.options.attach.owner_id) {
      this.handleInvalidServerFrame(connection, new Error("delivery owner_id does not match attach owner_id"));
      return;
    }
    if (message.payload.binding_revision !== this.options.attach.binding_revision) {
      this.handleInvalidServerFrame(connection, new Error("delivery binding_revision does not match attach binding_revision"));
      return;
    }

    const deliveryId = message.payload.delivery_id;
    if (this.seenDeliveryIds.has(deliveryId)) {
      this.emit({ event: "delivery_duplicate", message_id: message.message_id, delivery_id: deliveryId });
    } else {
      this.seenDeliveryIds.add(deliveryId);
      this.emit({ event: "delivery_processed", message_id: message.message_id, delivery_id: deliveryId });
    }

    const ack = createAck(deliveryId);
    connection.socket.write(encodeFrame(ack));
    this.emit({ event: "ack_sent", message_id: ack.message_id, delivery_id: deliveryId });
  }

  private handleInvalidServerFrame(connection: ActiveConnection, error: unknown): void {
    const reason = error instanceof Error ? error.message : String(error);
    this.emit({ event: "error", detail: reason });
    if (error instanceof FramingError || error instanceof ProtocolError) {
      this.failBeforeAttach(error, connection);
      return;
    }
    this.failBeforeAttach(new Error(reason), connection);
  }

  private failBeforeAttach(error: Error, connection: ActiveConnection): void {
    if (!connection.attached) {
      this.rejectFirstAttach?.(error);
      this.rejectFirstAttach = undefined;
      this.resolveFirstAttach = undefined;
    }
    connection.socket.destroy();
  }

  private scheduleReconnect(connection: ActiveConnection): void {
    if (this.stopped || connection.reconnectScheduled || this.reconnectTimer) return;
    connection.reconnectScheduled = true;

    const delay = this.reconnectDelaysMs[Math.min(this.reconnectAttempt, this.reconnectDelaysMs.length - 1)] ?? 0;
    this.emit({ event: "reconnect_scheduled", detail: `delay_ms=${delay}` });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.stopped) return;
      this.reconnectAttempt += 1;
      this.emit({ event: "reconnecting" });
      this.connect();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private emit(event: Omit<ClientEvent, "component">): void {
    this.options.onEvent({ component: "pi-extension", ...event });
  }
}
