export declare class ApiError extends Error {
    readonly statusCode: number;
    constructor(statusCode: number, message: string);
}
export declare function assert(condition: unknown, statusCode: number, message: string): asserts condition;
