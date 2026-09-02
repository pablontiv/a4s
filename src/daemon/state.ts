import type { DeliveryMessage } from "../protocol/messages.ts";

export type DeliveryStatus = "PENDING" | "ACKNOWLEDGED";
export type AckResult = "acknowledged" | "already_acknowledged" | "unknown";

export interface DeliveryRecord {
  message: DeliveryMessage;
  status: DeliveryStatus;
  sendCount: number;
}

export class DeliveryStore {
  private readonly records = new Map<string, DeliveryRecord>();

  enqueue(message: DeliveryMessage): void {
    const deliveryId = message.payload.delivery_id;
    if (this.records.has(deliveryId)) {
      throw new Error(`duplicate delivery_id: ${deliveryId}`);
    }

    this.records.set(deliveryId, {
      message,
      status: "PENDING",
      sendCount: 0,
    });
  }

  markSent(deliveryId: string): void {
    const record = this.records.get(deliveryId);
    if (!record) {
      throw new Error(`unknown delivery_id: ${deliveryId}`);
    }

    record.sendCount += 1;
  }

  acknowledge(deliveryId: string): AckResult {
    const record = this.records.get(deliveryId);
    if (!record) {
      return "unknown";
    }

    if (record.status === "ACKNOWLEDGED") {
      return "already_acknowledged";
    }

    record.status = "ACKNOWLEDGED";
    return "acknowledged";
  }

  pendingFor(ownerId: string, bindingRevision: 1): DeliveryMessage[] {
    const pending: DeliveryMessage[] = [];
    for (const record of this.records.values()) {
      if (
        record.status === "PENDING" &&
        record.message.payload.owner_id === ownerId &&
        record.message.payload.binding_revision === bindingRevision
      ) {
        pending.push(record.message);
      }
    }
    return pending;
  }

  get(deliveryId: string): Readonly<DeliveryRecord> | undefined {
    const record = this.records.get(deliveryId);
    if (!record) {
      return undefined;
    }
    return {
      message: cloneDeliveryMessage(record.message),
      status: record.status,
      sendCount: record.sendCount,
    };
  }

  counts(): { pending: number; acknowledged: number } {
    let pending = 0;
    let acknowledged = 0;
    for (const record of this.records.values()) {
      if (record.status === "PENDING") {
        pending += 1;
      } else {
        acknowledged += 1;
      }
    }
    return { pending, acknowledged };
  }
}

function cloneDeliveryMessage(message: DeliveryMessage): DeliveryMessage {
  return {
    protocol_version: message.protocol_version,
    message_id: message.message_id,
    type: message.type,
    payload: {
      delivery_id: message.payload.delivery_id,
      owner_id: message.payload.owner_id,
      binding_revision: message.payload.binding_revision,
      kind: message.payload.kind,
      body: {
        nonce: message.payload.body.nonce,
      },
    },
  };
}
