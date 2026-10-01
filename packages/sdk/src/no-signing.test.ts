// The SDK builds unsigned transactions and reads accounts. It must never hold
// a private key or produce a signature. This test fails if any shipped source
// file imports or mentions a key or signing API.

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('.', import.meta.url));

function shippedSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      return entry.name === '__fixtures__' ? [] : shippedSources(path);
    }
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

const FORBIDDEN: readonly (readonly [string, RegExp])[] = [
  ['Keypair', /\bKeypair\b/],
  ['Signer type', /\bSigner\b/],
  ['secret key', /secretKey|fromSecretKey|fromSeed\b|privateKey|private_key/],
  ['seed phrase', /mnemonic|seed phrase|bip39/i],
  ['signing call', /\.sign\(|\.partialSign\(|\.addSignature\(/],
  ['wallet signing', /signTransaction|signAllTransactions|signMessage/],
  ['send-and-sign helper', /sendAndConfirmTransaction|sendAndConfirmRawTransaction/],
  ['signature library', /tweetnacl|@noble\/ed25519|@noble\/curves|ed25519/],
  ['file system access', /from 'node:fs'|from 'fs'|require\(/],
  ['environment access', /process\.env/],
  ['GitHub credential', /GITHUB_|github_token|client_secret/i],
];

/** Names imported from @solana/web3.js across the shipped sources. */
function web3Imports(source: string): string[] {
  return [...source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'@solana\/web3\.js'/g)]
    .flatMap((match) => (match[1] ?? '').split(','))
    .map((name) => name.replace(/\btype\b/, '').trim())
    .filter((name) => name !== '');
}

describe('the SDK never signs', () => {
  const files = shippedSources(SRC);

  it('scans the real source tree', () => {
    const names = files.map((file) => file.slice(SRC.length));
    expect(names).toContain('/instructions.ts');
    expect(names).toContain('/transaction.ts');
    expect(names).toContain('/generated/idl.ts');
    expect(names.some((name) => name.endsWith('.test.ts'))).toBe(false);
    expect(files.length).toBeGreaterThanOrEqual(18);
  });

  // generated/idl.ts is the program's IDL as data (its error messages contain
  // words such as "Signer"). It is checked separately: it may hold no code.
  const generated = files.filter((file) => file.endsWith('/generated/idl.ts'));
  const handwritten = files.filter((file) => !generated.includes(file));

  it('the generated IDL module is pure data', () => {
    expect(generated).toHaveLength(1);
    for (const file of generated) {
      const source = readFileSync(file, 'utf8');
      expect(source).not.toMatch(/^\s*import\s/m);
      expect(source).not.toMatch(/require\(|=>|function\s|\bnew\s/);
      expect(source.trimEnd().endsWith('} as const;')).toBe(true);
    }
  });

  it.each(FORBIDDEN)('no shipped source mentions a %s', (_, pattern) => {
    const offenders = handwritten.filter((file) => pattern.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('imports only data types from @solana/web3.js', () => {
    const imported = new Set(files.flatMap((file) => web3Imports(readFileSync(file, 'utf8'))));
    expect([...imported].sort()).toEqual([
      'PublicKey',
      'TransactionInstruction',
      'TransactionMessage',
      'VersionedTransaction',
    ]);
  });

  it('the patterns do catch a signing import', () => {
    const sample = "import { Keypair } from '@solana/web3.js';\ntx.sign([payer]);";
    expect(FORBIDDEN.filter(([, pattern]) => pattern.test(sample)).map(([name]) => name)).toEqual([
      'Keypair',
      'signing call',
    ]);
    expect(web3Imports(sample)).toEqual(['Keypair']);
  });
});
