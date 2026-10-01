import { buildApp } from './app.js';
import { loadApiConfig } from './config.js';

const config = loadApiConfig(process.env);
const app = buildApp({ logger: config.NODE_ENV !== 'test' });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close();
  });
}

await app.listen({ host: config.API_HOST, port: config.API_PORT });
