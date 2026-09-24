import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { ZodError } from 'zod';
import { AppError, type ApiErrorBody, type ErrorCode } from '@yuha/contracts';

/**
 * Uniform error rendering.
 *
 * SEC-06: nothing that leaves this handler contains a secret, a stack trace or
 * a raw prompt. Unexpected errors are logged in full server side and reported
 * to the client only as INTERNAL_ERROR plus the request id.
 */
export default fp(async function errorPlugin(app: FastifyInstance) {
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      if (err.status >= 500) req.log.error({ err, code: err.code }, 'application error');
      else req.log.info({ code: err.code }, 'request rejected');
      return reply.status(err.status).send(err.toBody(req.id));
    }

    if (err instanceof ZodError) {
      const body: ApiErrorBody = {
        error: {
          code: 'VALIDATION_FAILED',
          message: 'request validation failed',
          details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
          requestId: req.id,
        },
      };
      return reply.status(400).send(body);
    }

    // Fastify's own errors carry a statusCode; anything 4xx is a client problem
    // and safe to name, anything else becomes a generic 500.
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status === 429) {
      return reply.status(429).send({
        error: { code: 'RATE_LIMITED' as ErrorCode, message: 'too many requests', requestId: req.id },
      });
    }
    if (status >= 400 && status < 500) {
      return reply.status(status).send({
        error: {
          code: 'VALIDATION_FAILED' as ErrorCode,
          message: (err as Error).message,
          requestId: req.id,
        },
      });
    }

    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({
      error: {
        code: 'INTERNAL_ERROR' as ErrorCode,
        message: 'internal error',
        requestId: req.id,
      },
    });
  });

  app.setNotFoundHandler((req, reply) =>
    reply.status(404).send({
      error: { code: 'NOT_FOUND' as ErrorCode, message: 'route not found', requestId: req.id },
    }),
  );
});
