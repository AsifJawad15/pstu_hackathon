export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: unknown;

  constructor(
    code: string,
    message: string,
    status = 400,
    details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function invariant(condition: unknown, code: string, message: string, status = 400): asserts condition {
  if (!condition) throw new AppError(code, message, status);
}
