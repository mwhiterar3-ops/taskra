import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { TaskraSdkError } from '@taskra/sdk';
import { ChainUnavailableError } from './chain/reader.js';

/** An error whose code and message are safe to show to any caller. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const unauthorized = () => new ApiError(401, 'UNAUTHENTICATED', 'Sign in with your wallet.');
export const forbidden = (message: string) => new ApiError(403, 'FORBIDDEN', message);
export const notFound = (what: string) => new ApiError(404, 'NOT_FOUND', `${what} was not found.`);
export const conflict = (code: string, message: string) => new ApiError(409, code, message);

interface ErrorBody {
  readonly error: { readonly code: string; readonly message: string; readonly details?: unknown };
}

function body(code: string, message: string, details?: unknown): ErrorBody {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}

/**
 * Every error leaves the API as `{ error: { code, message, details? } }`.
 * Anything unexpected is logged in full and reported only as INTERNAL: no
 * stack trace, SQL text or configuration ever reaches a response.
 */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((_request, reply) =>
    reply.status(404).send(body('NOT_FOUND', 'Route not found.')),
  );

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof ApiError) {
      return reply.status(error.status).send(body(error.code, error.message, error.details));
    }
    if (error instanceof ZodError) {
      const details = error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      }));
      return reply.status(400).send(body('VALIDATION_ERROR', 'The request is invalid.', details));
    }
    if (error instanceof TaskraSdkError && error.code === 'INVALID_ARGUMENT') {
      return reply.status(400).send(body('VALIDATION_ERROR', error.message));
    }
    if (error instanceof ChainUnavailableError) {
      request.log.warn({ err: error }, 'Solana RPC unavailable');
      return reply
        .status(503)
        .header('retry-after', '5')
        .send(body('RPC_UNAVAILABLE', 'The Solana RPC endpoint is unavailable. Try again.'));
    }
    const status = (error as FastifyError).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      // Framework-level client errors: malformed JSON, payload too large, rate limit.
      const code = status === 429 ? 'RATE_LIMITED' : 'BAD_REQUEST';
      const message = status === 429 ? 'Too many requests. Slow down.' : 'The request is invalid.';
      return reply.status(status).send(body(code, message));
    }
    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send(body('INTERNAL', 'Internal error.'));
  });
}
