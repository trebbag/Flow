import { ApiError } from "./errors.js";

export async function applyVersionedUpdateTx<TRow>(params: {
  update: () => Promise<{ count: number }>;
  findLatest: () => Promise<{ id: string } | null>;
  read: () => Promise<TRow>;
  notFoundMessage: string;
  notFoundCode: string;
  conflictMessage: string;
}) {
  const updateResult = await params.update();
  if (updateResult.count === 0) {
    const latest = await params.findLatest();
    if (!latest) {
      throw new ApiError({
        statusCode: 404,
        code: params.notFoundCode,
        message: params.notFoundMessage,
      });
    }
    throw new ApiError({
      statusCode: 409,
      code: "VERSION_MISMATCH",
      message: params.conflictMessage,
    });
  }

  return params.read();
}
