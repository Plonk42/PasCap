export class ServiceError extends Error {
  constructor(message: string, public readonly statusCode = 400) { super(message); this.name = 'ServiceError'; }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unexpected service error.';
}

export function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}