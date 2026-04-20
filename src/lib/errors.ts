export type ApiErrorDetails = unknown;

export type ApiErrorInput = {
  statusCode: number;
  code?: string;
  message: string;
  details?: ApiErrorDetails;
  expose?: boolean;
};

function defaultApiErrorCode(statusCode: number) {
  if (statusCode === 400) return "BAD_REQUEST";
  if (statusCode === 401) return "UNAUTHORIZED";
  if (statusCode === 403) return "FORBIDDEN";
  if (statusCode === 404) return "NOT_FOUND";
  if (statusCode === 409) return "CONFLICT";
  if (statusCode === 422) return "UNPROCESSABLE_ENTITY";
  if (statusCode >= 500) return "INTERNAL_SERVER_ERROR";
  return "REQUEST_ERROR";
}

export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: ApiErrorDetails;
  readonly expose: boolean;

  constructor(input: number | ApiErrorInput, message?: string, code?: string, details?: ApiErrorDetails) {
    const payload: ApiErrorInput =
      typeof input === "number"
        ? {
            statusCode: input,
            message: message || "Request failed",
            code,
            details,
          }
        : input;

    super(payload.message);
    this.name = "ApiError";
    this.statusCode = payload.statusCode;
    this.code = payload.code || defaultApiErrorCode(payload.statusCode);
    this.details = payload.details;
    this.expose = payload.expose ?? payload.statusCode < 500;
  }
}

export function requireCondition(
  condition: unknown,
  statusCode: number,
  message: string,
  code?: string,
  details?: ApiErrorDetails,
): asserts condition {
  if (!condition) {
    throw new ApiError({
      statusCode,
      message,
      code,
      details,
      expose: statusCode < 500,
    });
  }
}

export function assert(
  condition: unknown,
  statusCode: number,
  message: string,
  code?: string,
  details?: ApiErrorDetails,
): asserts condition {
  requireCondition(condition, statusCode, message, code, details);
}

export function requireFound<T>(
  value: T,
  message: string,
  code = "NOT_FOUND",
  details?: ApiErrorDetails,
): NonNullable<T> {
  if (value === null || value === undefined || value === false) {
    throw new ApiError({
      statusCode: 404,
      code,
      message,
      details,
      expose: true,
    });
  }
  return value as NonNullable<T>;
}

export function requireBadRequest(
  condition: unknown,
  message: string,
  code = "BAD_REQUEST",
  details?: ApiErrorDetails,
): asserts condition {
  requireCondition(condition, 400, message, code, details);
}

export function requireForbidden(
  condition: unknown,
  message: string,
  code = "FORBIDDEN",
  details?: ApiErrorDetails,
): asserts condition {
  requireCondition(condition, 403, message, code, details);
}

export function requireConflict(
  condition: unknown,
  message: string,
  code = "CONFLICT",
  details?: ApiErrorDetails,
): asserts condition {
  requireCondition(condition, 409, message, code, details);
}

export function invariant(condition: unknown, message: string, details?: ApiErrorDetails): asserts condition {
  if (!condition) {
    throw new ApiError({
      statusCode: 500,
      code: "INVARIANT_VIOLATION",
      message,
      details,
      expose: false,
    });
  }
}

export function asApiError(error: unknown, fallback?: Partial<ApiErrorInput>) {
  if (error instanceof ApiError) {
    return error;
  }

  return new ApiError({
    statusCode: fallback?.statusCode || 500,
    code: fallback?.code,
    message: fallback?.message || (error instanceof Error ? error.message : "Internal server error"),
    details: fallback?.details,
    expose: fallback?.expose,
  });
}
