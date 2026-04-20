import { z } from "zod";
import { ApiError } from "./errors.js";

export const paginationQuerySchema = z.object({
  cursor: z.string().trim().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
});

export type PaginationWindow = {
  offset: number;
  pageSize: number;
};

export type PaginatedResponse<T> = {
  items: T[];
  nextCursor: string | null;
  pageSize: number;
};

function encodeOffsetCursor(offset: number) {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

function decodeOffsetCursor(cursor?: string) {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { offset?: unknown };
    const offset = Number(parsed?.offset);
    if (!Number.isInteger(offset) || offset < 0) {
      throw new ApiError({
        statusCode: 400,
        code: "INVALID_PAGINATION_CURSOR",
        message: "Pagination cursor is invalid.",
      });
    }
    return offset;
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    throw new ApiError({
      statusCode: 400,
      code: "INVALID_PAGINATION_CURSOR",
      message: "Pagination cursor is invalid.",
    });
  }
}

export function resolveOptionalPagination(
  input: { cursor?: string; pageSize?: number | null | undefined },
  defaults?: { pageSize?: number },
): PaginationWindow | null {
  if (!input.cursor && !input.pageSize) {
    return null;
  }

  return {
    offset: decodeOffsetCursor(input.cursor),
    pageSize: input.pageSize || defaults?.pageSize || 50,
  };
}

export function paginateItems<T>(items: T[], pagination: PaginationWindow): PaginatedResponse<T> {
  const hasMore = items.length > pagination.pageSize;
  const pageItems = hasMore ? items.slice(0, pagination.pageSize) : items;
  return {
    items: pageItems,
    nextCursor: hasMore ? encodeOffsetCursor(pagination.offset + pagination.pageSize) : null,
    pageSize: pagination.pageSize,
  };
}
