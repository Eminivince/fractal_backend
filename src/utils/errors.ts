export class HttpError extends Error {
  statusCode: number;
  details?: unknown;

  constructor(statusCode: number, message: string, details?: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
  }
}

export function assert(condition: unknown, statusCode: number, message: string, details?: unknown): asserts condition {
  if (!condition) throw new HttpError(statusCode, message, details);
}
