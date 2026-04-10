import { EventEmitter } from "node:events";
const bus = new EventEmitter();
bus.setMaxListeners(500);
const OUTBOX_EVENT = "outbox_event";
export function publishOutboxStreamEvent(event) {
    bus.emit(OUTBOX_EVENT, event);
}
export function subscribeOutboxStreamEvent(listener) {
    bus.on(OUTBOX_EVENT, listener);
    return () => {
        bus.off(OUTBOX_EVENT, listener);
    };
}
//# sourceMappingURL=event-bus.js.map