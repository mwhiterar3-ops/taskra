import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { loadApiConfig } from './config.js';

describe('API', () => {
  const app = buildApp({ logger: false });

  afterAll(async () => {
    await app.close();
  });

  it('answers GET /health', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('returns 404 for unknown routes', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/tasks' });
    expect(response.statusCode).toBe(404);
  });
});

describe('API config', () => {
  it('loads the listen configuration', () => {
    const config = loadApiConfig({ NODE_ENV: 'test', API_HOST: '127.0.0.1', API_PORT: '4000' });
    expect(config).toEqual({ NODE_ENV: 'test', API_HOST: '127.0.0.1', API_PORT: 4000 });
  });

  it('refuses to start without a port', () => {
    expect(() => loadApiConfig({ NODE_ENV: 'test', API_HOST: '127.0.0.1' })).toThrow(
      /API_PORT: is required/,
    );
  });
});
