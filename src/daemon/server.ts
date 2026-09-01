import { createServer, type Server, type Socket } from "node:net";
import { DeliveryStore } from "./state.ts";
import {
  advertiseUnixEndpointBinding,
  cleanupUnixEndpointBinding,
  createUnixEndpointBinding,
  type UnixEndpointBinding,
} from "./endpoint.ts";
import { encodeFrame, FrameDecoder, FramingError } from "../protocol/framing.ts";
import {
  createAttached,
  createDelivery,
  createProtocolError,
  parseMessage,
  ProtocolError,
  type DeliveryAckMessage,
  type DeliveryMessage,
  type ErrorCode,
  type ProtocolMessage,
} from "../protocol/messages.ts";

export interface ServerEvent {
  component: "a4sd";
  event: string;
  message_id?: string;
  delivery_id?: string;
  detail?: string;
}

export interface E0ServerOptions {
  endpoint: string;
  expectedOwnerId: string;
  expectedBindingRevision: 1;
  onEvent(event: ServerEvent): void;
}

export interface FaultController {
  duplicateNextDelivery(): void;
  dropNextAckAndDisconnect(): void;
}

interface ClientState {
  decoder: FrameDecoder;
  attached: boolean;
  closing: boolean;
}

export class E0Server {
  readonly faults: FaultController;
  private readonly store = new DeliveryStore();
  private readonly clients = new Map<Socket, ClientState>();
  private server: Server | undefined;
  private unixEndpointBinding: UnixEndpointBinding | undefined;
  private duplicateNextDeliveryFault = false;
  private dropNextAckAndDisconnectFault = false;

  constructor(private readonly options: E0ServerOptions) {
    this.faults = {
      duplicateNextDelivery: () => {
        this.duplicateNextDeliveryFault = true;
      },
      dropNextAckAndDisconnect: () => {
        this.dropNextAckAndDisconnectFault = true;
      },
    };
  }

  async start(): Promise<void> {
    if (this.server) throw new Error("server already started");
    const unixEndpointBinding = isWindowsPipe(this.options.endpoint)
      ? undefined
      : await createUnixEndpointBinding(this.options.endpoint);
    const listenEndpoint = unixEndpointBinding?.listenEndpoint ?? this.options.endpoint;

    const server = createServer((socket) => this.handleConnection(socket));
    this.server = server;

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(listenEndpoint, resolve);
      });
      if (unixEndpointBinding) {
        await advertiseUnixEndpointBinding(unixEndpointBinding);
        this.unixEndpointBinding = unixEndpointBinding;
      }
      this.emit({ event: "listening", detail: this.options.endpoint });
    } catch (error) {
      this.server = undefined;
      this.unixEndpointBinding = undefined;
      if (server.listening) {
        await closeServer(server);
      }
      if (unixEndpointBinding) {
        await cleanupUnixEndpointBinding(unixEndpointBinding);
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    for (const socket of this.clients.keys()) {
      socket.destroy();
    }

    const server = this.server;
    const unixEndpointBinding = this.unixEndpointBinding;
    this.server = undefined;
    this.unixEndpointBinding = undefined;

    if (server?.listening) {
      await closeServer(server);
    }

    if (unixEndpointBinding) {
      await cleanupUnixEndpointBinding(unixEndpointBinding);
    }
  }

  enqueueProbe(deliveryId: string, nonce: string): void {
    this.store.enqueue(createDelivery(deliveryId, this.options.expectedOwnerId, nonce));
  }

  disconnectClient(): void {
    for (const socket of this.clients.keys()) {
      socket.destroy();
    }
  }

  counts(): { pending: number; acknowledged: number } {
    return this.store.counts();
  }

  private handleConnection(socket: Socket): void {
    const state: ClientState = {
      decoder: new FrameDecoder(),
      attached: false,
      closing: false,
    };
    this.clients.set(socket, state);
    this.emit({ event: "client_connected" });

    socket.on("data", (chunk: Buffer) => {
      this.handleData(socket, state, chunk);
    });
    socket.once("error", (error) => {
      this.emit({ event: "socket_error", detail: error.message });
    });
    socket.once("close", () => {
      this.clients.delete(socket);
      this.emit({ event: "client_closed" });
    });
  }

  private handleData(socket: Socket, state: ClientState, chunk: Buffer): void {
    let values: unknown[];
    try {
      values = state.decoder.push(chunk);
    } catch (error) {
      if (error instanceof FramingError) {
        this.emit({ event: "framing_error", detail: error.message });
        state.closing = true;
        socket.destroy();
        return;
      }
      throw error;
    }

    for (const value of values) {
      if (state.closing) return;
      const message = this.parseClientMessage(socket, state, value);
      if (!message) return;
      this.emit({ event: "message_received", message_id: message.message_id, detail: message.type });

      if (!state.attached) {
        this.handlePreAttachMessage(socket, state, message);
      } else {
        this.handleAttachedMessage(socket, state, message);
      }
    }
  }

  private parseClientMessage(socket: Socket, state: ClientState, value: unknown): ProtocolMessage | undefined {
    try {
      return parseMessage(value);
    } catch (error) {
      if (error instanceof ProtocolError) {
        const messageId = messageIdFromRaw(value);
        if (messageId) {
          this.emit({ event: "protocol_error", message_id: messageId, detail: error.message });
          this.writeError(socket, messageId, error.code, error.message, true, state);
        } else {
          this.emit({ event: "protocol_error", detail: error.message });
          state.closing = true;
          socket.destroy();
        }
        return undefined;
      }
      throw error;
    }
  }

  private handlePreAttachMessage(socket: Socket, state: ClientState, message: ProtocolMessage): void {
    if (message.type !== "attach") {
      this.writeError(socket, message.message_id, "ATTACH_REQUIRED", "attach is required as the first message", true, state);
      return;
    }

    if (message.payload.owner_id !== this.options.expectedOwnerId) {
      this.writeError(socket, message.message_id, "INVALID_ATTACH", "owner_id does not match expected owner", true, state);
      return;
    }

    if (message.payload.binding_revision !== this.options.expectedBindingRevision) {
      this.writeError(socket, message.message_id, "STALE_BINDING", "binding_revision is stale", true, state);
      return;
    }

    state.attached = true;
    const attached = createAttached(message.message_id, this.options.expectedOwnerId);
    socket.write(encodeFrame(attached));
    this.emit({ event: "message_sent", message_id: attached.message_id, detail: "attached" });
    this.sendPendingDeliveries(socket);
  }

  private handleAttachedMessage(socket: Socket, state: ClientState, message: ProtocolMessage): void {
    if (message.type !== "delivery_ack") {
      this.writeError(socket, message.message_id, "UNEXPECTED_MESSAGE", "only delivery_ack is allowed after attach", true, state);
      return;
    }

    this.handleDeliveryAck(socket, state, message);
  }

  private handleDeliveryAck(socket: Socket, state: ClientState, message: DeliveryAckMessage): void {
    this.emit({ event: "ack_received", message_id: message.message_id, delivery_id: message.payload.delivery_id });

    if (this.dropNextAckAndDisconnectFault) {
      this.dropNextAckAndDisconnectFault = false;
      this.emit({ event: "fault", message_id: message.message_id, delivery_id: message.payload.delivery_id, detail: "drop_next_ack_and_disconnect" });
      state.closing = true;
      socket.destroy();
      return;
    }

    const result = this.store.acknowledge(message.payload.delivery_id);
    if (result === "acknowledged") {
      this.emit({ event: "acknowledged", message_id: message.message_id, delivery_id: message.payload.delivery_id });
      return;
    }

    this.writeError(
      socket,
      message.message_id,
      "UNEXPECTED_MESSAGE",
      result === "unknown" ? "unknown delivery ACK" : "delivery already acknowledged",
      false,
      state,
    );
  }

  private sendPendingDeliveries(socket: Socket): void {
    for (const delivery of this.store.pendingFor(this.options.expectedOwnerId, this.options.expectedBindingRevision)) {
      this.writeDelivery(socket, delivery);
    }
  }

  private writeDelivery(socket: Socket, delivery: DeliveryMessage): void {
    const frame = encodeFrame(delivery);
    this.writeDeliveryFrame(socket, delivery, frame);

    if (this.duplicateNextDeliveryFault) {
      this.duplicateNextDeliveryFault = false;
      this.emit({ event: "fault", delivery_id: delivery.payload.delivery_id, detail: "duplicate_next_delivery" });
      this.writeDeliveryFrame(socket, delivery, frame);
    }
  }

  private writeDeliveryFrame(socket: Socket, delivery: DeliveryMessage, frame: Buffer): void {
    const deliveryId = delivery.payload.delivery_id;
    this.store.markSent(deliveryId);
    const sendCount = this.store.get(deliveryId)?.sendCount;
    socket.write(frame);
    this.emit({
      event: "delivery_sent",
      message_id: delivery.message_id,
      delivery_id: deliveryId,
      detail: `send_count=${sendCount ?? "unknown"}`,
    });
  }

  private writeError(
    socket: Socket,
    inReplyTo: string,
    code: ErrorCode,
    message: string,
    closeAfterWrite: boolean,
    state: ClientState,
  ): void {
    const error = createProtocolError(inReplyTo, code, message);
    const frame = encodeFrame(error);
    if (closeAfterWrite) {
      state.closing = true;
      socket.end(frame);
    } else {
      socket.write(frame);
    }
    this.emit({ event: "protocol_error", message_id: inReplyTo, detail: code });
    this.emit({ event: "message_sent", message_id: error.message_id, detail: "error" });
  }

  private emit(event: Omit<ServerEvent, "component">): void {
    this.options.onEvent({ component: "a4sd", ...event });
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function messageIdFromRaw(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const messageId = (value as { message_id?: unknown }).message_id;
  return typeof messageId === "string" && messageId.length > 0 ? messageId : undefined;
}

function isWindowsPipe(endpoint: string): boolean {
  return endpoint.startsWith("\\\\.\\pipe\\");
}
