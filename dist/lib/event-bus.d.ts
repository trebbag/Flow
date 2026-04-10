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
export declare function publishOutboxStreamEvent(event: OutboxStreamEvent): void;
export declare function subscribeOutboxStreamEvent(listener: (event: OutboxStreamEvent) => void): () => void;
