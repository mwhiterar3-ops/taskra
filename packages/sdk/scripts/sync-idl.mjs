// Copies the IDL produced by `anchor build` into the SDK as a typed module.
// Run through `pnpm --filter @taskra/sdk idl:sync` after every program change.
import { readFileSync, writeFileSync } from 'node:fs';

const source = new URL('../../../target/idl/taskra.json', import.meta.url);
const target = new URL('../src/generated/idl.ts', import.meta.url);

const idl = JSON.parse(readFileSync(source, 'utf8'));
const header =
  '// Generated from target/idl/taskra.json by scripts/sync-idl.mjs. Do not edit by hand.\n';
writeFileSync(target, `${header}export const IDL = ${JSON.stringify(idl, null, 2)} as const;\n`);
console.log(
  `IDL ${idl.metadata.name} ${idl.metadata.version} (${idl.address}): ` +
    `${idl.instructions.length} instructions, ${idl.errors.length} errors`,
);
