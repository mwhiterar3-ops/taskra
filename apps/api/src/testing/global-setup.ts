import { fileURLToPath } from 'node:url';
import { setupTestPostgres } from '@taskra/shared/testing/postgres';

export default function setup(): Promise<() => Promise<void>> {
  return setupTestPostgres(fileURLToPath(new URL('../../migrations', import.meta.url)));
}
