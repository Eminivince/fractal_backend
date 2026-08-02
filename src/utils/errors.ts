export class HttpError extends Error {
  statusCode: number;
  details?: unknown;
  code?: string;

  constructor(statusCode: number, message: string, details?: unknown, code?: string) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
    this.code = code;
  }
}

export function assert(condition: unknown, statusCode: number, message: string, details?: unknown): asserts condition {
  if (!condition) throw new HttpError(statusCode, message, details);
}
