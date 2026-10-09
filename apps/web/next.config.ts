import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import type { NextConfig } from 'next';

// The environment contract lives in one `.env` at the repository root
// (docs/10-ENVIRONMENT-SPEC.md). Next.js only reads `.env` files next to the
// app, so the root file is read here, and ONLY its `NEXT_PUBLIC_*` variables
// are taken. Variables already set in the environment win.
const rootEnv = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(rootEnv)) {
  for (const [name, value] of Object.entries(parseEnv(readFileSync(rootEnv, 'utf8')))) {
    if (name.startsWith('NEXT_PUBLIC_') && process.env[name] === undefined) {
      process.env[name] = value;
    }
  }
}

// The web app uses no server secret. The build tool caches the environment it
// ran in under `.next/cache`, so secrets that belong to other processes are
// removed from this one before anything is built, even if the shell exported them.
for (const name of [
  'ATTESTER_SECRET_KEY',
  'DATABASE_URL',
  'POSTGRES_PASSWORD',
  'GITHUB_CLIENT_SECRET',
]) {
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- fixed names
  delete process.env[name];
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  headers() {
    return Promise.resolve([
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ]);
  },
};

export default nextConfig;
