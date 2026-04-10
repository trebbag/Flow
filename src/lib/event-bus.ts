import { EventEmitter } from "node:events";

export type OutboxStreamEvent = {
  id: string;
  topic: string;
  eventType: string;
  requestId: string | null;
  status: string;
  createdAt: string;
  aggregateType: string | null;
  aggregateId: string | null;
  payload: unknown;
};

const bus = new EventEmitter();
bus.setMaxListeners(500);

const OUTBOX_EVENT = "outbox_event";

export function publishOutboxStreamEvent(event: OutboxStreamEvent) {
  bus.emit(OUTBOX_EVENT, event);
}

export function subscribeOutboxStreamEvent(listener: (event: OutboxStreamEvent) => void) {
  bus.on(OUTBOX_EVENT, listener);
  return () => {
    bus.off(OUTBOX_EVENT, listener);
  };
}
