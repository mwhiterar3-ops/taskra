import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerAuthRoutes } from './auth/routes.js';
import type { AppDeps } from './deps.js';
import { ApiError, registerErrorHandling } from './errors.js';
import { registerGithubRoutes } from './github/routes.js';
import { registerTaskRoutes } from './tasks/routes.js';
import { registerUserRoutes } from './users/routes.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const webOrigin = new URL(deps.config.WEB_ORIGIN).origin;
  const app = Fastify({
    logger: deps.logger
      ? { redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'] }
      : false,
    bodyLimit: 64 * 1024,
  });
  registerErrorHandling(app);

  await app.register(cookie);
  // Only the web app's origin may read responses or send credentials.
  await app.register(cors, {
    origin: webOrigin,
    credentials: true,
    methods: ['GET', 'POST'],
    allowedHeaders: ['content-type'],
    maxAge: 600,
  });
  if (deps.rateLimit) {
    await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute' });
  }

  app.addHook('onRequest', (request, reply, done) => {
    void reply.header('x-content-type-options', 'nosniff').header('cache-control', 'no-store');
    // CSRF: the session cookie is SameSite=Strict, and in addition every
    // state-changing request must come from the web app's own origin.
    if (!SAFE_METHODS.has(request.method) && request.headers.origin !== webOrigin) {
      done(new ApiError(403, 'CSRF_ORIGIN', 'This request did not come from the Taskra web app.'));
      return;
    }
    done();
  });

  // Liveness: the process is serving requests. Says nothing about dependencies.
  app.get('/health', () => ({ status: 'ok' }));

  // Readiness: the database and the RPC endpoint both answer. Reports which
  // dependency failed and nothing about how it is configured.
  app.get('/ready', async (_request, reply) => {
    const check = async (probe: () => Promise<unknown>): Promise<'ok' | 'unavailable'> => {
      try {
        await probe();
        return 'ok';
      } catch {
        return 'unavailable';
      }
    };
    const [database, rpc] = await Promise.all([
      check(() => deps.pool.query('SELECT 1')),
      check(() => deps.chain.ping()),
    ]);
    const ready = database === 'ok' && rpc === 'ok';
    return reply
      .status(ready ? 200 : 503)
      .send({ status: ready ? 'ready' : 'not_ready', checks: { database, rpc } });
  });

  registerAuthRoutes(app, deps);
  registerTaskRoutes(app, deps);
  registerUserRoutes(app, deps);
  registerGithubRoutes(app, deps);
  return app;
}
