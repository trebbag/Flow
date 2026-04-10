export class ApiError extends Error {
    statusCode;
    constructor(statusCode, message) {
        super(message);
        this.statusCode = statusCode;
    }
}
export function assert(condition, statusCode, message) {
    if (!condition) {
        throw new ApiError(statusCode, message);
    }
}
//# sourceMappingURL=errors.js.map