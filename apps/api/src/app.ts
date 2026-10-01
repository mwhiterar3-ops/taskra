import Fastify, { type FastifyInstance } from 'fastify';

export interface AppOptions {
  readonly logger: boolean;
}

export function buildApp(options: AppOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger });

  // Liveness only: reports that the process is serving requests.
  app.get('/health', () => ({ status: 'ok' }));

  return app;
}
