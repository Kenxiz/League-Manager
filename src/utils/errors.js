/**
 * Application error hierarchy.
 *
 * `expose` errors have messages that are safe to show to Discord users.
 * Anything else is treated as an internal fault: it is logged in full and the user
 * only sees a generic message (so stack traces / SQL / paths never leak).
 */
export class AppError extends Error {
  /**
   * @param {string} message user-safe message when `expose` is true
   * @param {{ code?: string, expose?: boolean, cause?: unknown, details?: unknown }} [opts]
   */
  constructor(message, { code = 'APP_ERROR', expose = true, cause, details } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = new.target.name;
    this.code = code;
    this.expose = expose;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  constructor(message, opts) {
    super(message, { code: 'VALIDATION', ...opts });
  }
}

export class NotFoundError extends AppError {
  constructor(message, opts) {
    super(message, { code: 'NOT_FOUND', ...opts });
  }
}

export class ConflictError extends AppError {
  constructor(message, opts) {
    super(message, { code: 'CONFLICT', ...opts });
  }
}

export class PermissionError extends AppError {
  constructor(message = 'You do not have permission to do that.', opts) {
    super(message, { code: 'FORBIDDEN', ...opts });
  }
}

export class RateLimitError extends AppError {
  /** @param {number} retryAfterMs */
  constructor(retryAfterMs, opts) {
    const secs = Math.max(1, Math.ceil(retryAfterMs / 1000));
    super(`Slow down! Try again in ${secs}s.`, { code: 'RATE_LIMITED', ...opts, details: { retryAfterMs } });
  }
}

export class ExternalServiceError extends AppError {
  constructor(message = 'An external service is unavailable right now. Please try again later.', opts) {
    super(message, { code: 'EXTERNAL', ...opts });
  }
}

export class InternalError extends AppError {
  constructor(message = 'Something went wrong on our end.', opts) {
    super(message, { code: 'INTERNAL', expose: false, ...opts });
  }
}

export const GENERIC_USER_MESSAGE = 'Something went wrong on our end. Please try again later.';

/** Message safe to send to a user for any thrown value. */
export function toUserMessage(err) {
  return err instanceof AppError && err.expose ? err.message : GENERIC_USER_MESSAGE;
}
