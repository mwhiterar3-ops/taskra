import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { createTaskraConfig, findPlatformAddress, IDL } from '@taskra/sdk';
import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';
import { loadAttesterConfig } from './config.js';
import { createAttestationSigner } from './signer.js';
import { assertConfiguredAttester } from './startup.js';
import { FakeAttesterChain } from './testing/fakes.js';
import { key } from './testing/fixtures.js';

const config = createTaskraConfig({ cluster: 'localnet', usdcMint: key(7) });
// A throwaway key generated for this test run only.
const keypair = Keypair.generate();
const secretJson = JSON.stringify([...keypair.secretKey]);
const signer = createAttestationSigner(secretJson, config);
const task = key(40);
const hash = new Uint8Array(32).fill(0x5a);

describe('the attestation signer', () => {
  it('produces one record_attestation transaction and nothing else', () => {
    const signed = signer.signAttestation({
      task,
      evidenceHash: hash,
      submissionNonce: 3n,
      recentBlockhash: bs58.encode(new Uint8Array(32).fill(9)),
    });
    const transaction = VersionedTransaction.deserialize(signed.serialized);
    const { message } = transaction;

    expect(message.compiledInstructions).toHaveLength(1);
    const [instruction] = message.compiledInstructions;
    if (instruction === undefined) throw new Error('no instruction');
    const keys = instruction.accountKeyIndexes.map((index) => message.staticAccountKeys[index]);
    const definition = IDL.instructions.find((entry) => entry.name === 'record_attestation');

    expect(message.staticAccountKeys[instruction.programIdIndex]?.equals(config.programId)).toBe(
      true,
    );
    expect([...instruction.data.subarray(0, 8)]).toEqual(definition?.discriminator);
    expect(instruction.data.subarray(8, 40)).toEqual(hash);
    expect(Buffer.from(instruction.data).readBigUInt64LE(40)).toBe(3n);
    // attester, platform, task: no token account, so the transaction cannot move funds.
    expect(keys.map((entry) => entry?.toBase58())).toEqual([
      keypair.publicKey.toBase58(),
      findPlatformAddress(config.programId)[0].toBase58(),
      task.toBase58(),
    ]);
    expect(message.header.numRequiredSignatures).toBe(1);
    expect(bs58.encode(transaction.signatures[0] ?? new Uint8Array())).toBe(signed.signature);
  });

  it('exposes the public key and no key material', () => {
    expect(signer.publicKey.equals(keypair.publicKey)).toBe(true);
    expect(Object.keys(signer).sort()).toEqual(['publicKey', 'signAttestation']);
    const dump = JSON.stringify(signer);
    expect(dump).not.toContain(secretJson.slice(1, 40));
  });
});

describe('startup check', () => {
  it('accepts the key the Platform account names and refuses any other', async () => {
    const chain = new FakeAttesterChain(config.programId, keypair.publicKey);
    await expect(assertConfiguredAttester(chain, signer)).resolves.toBeUndefined();
    chain.platformAttester = key(77);
    await expect(assertConfiguredAttester(chain, signer)).rejects.toThrow(
      /Platform account records/,
    );
  });
});

describe('attester configuration', () => {
  it('requires the attester key and tolerates a missing GitHub app', () => {
    const env = {
      NODE_ENV: 'test',
      SOLANA_NETWORK: 'localnet',
      SOLANA_RPC_URL: 'http://127.0.0.1:8899',
      TASKRA_PROGRAM_ID: config.programId.toBase58(),
      USDC_MINT: key(7).toBase58(),
      DATABASE_URL: 'postgres://taskra:fixture@localhost:5432/taskra',
    };
    expect(() => loadAttesterConfig(env)).toThrow(/ATTESTER_SECRET_KEY: is required/);
    const loaded = loadAttesterConfig({ ...env, ATTESTER_SECRET_KEY: secretJson });
    expect(loaded.GITHUB_CLIENT_ID).toBeUndefined();
  });

  it('never puts a rejected key value in the error message', () => {
    try {
      loadAttesterConfig({ ATTESTER_SECRET_KEY: 'super-secret-not-a-key' });
      throw new Error('expected a validation error');
    } catch (error) {
      expect(String(error)).not.toContain('super-secret-not-a-key');
    }
  });
});

describe('isolation of the signing key', () => {
  const SRC = fileURLToPath(new URL('.', import.meta.url));
  const shipped = readdirSync(SRC, { withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'),
    )
    .map((entry) => entry.name);
  const read = (name: string) => readFileSync(`${SRC}/${name}`, 'utf8');

  it('scans the real source tree', () => {
    expect(shipped).toEqual(
      expect.arrayContaining(['signer.ts', 'worker.ts', 'main.ts', 'github.ts', 'rules.ts']),
    );
  });

  it('only signer.ts can create or use a private key', () => {
    const KEY_USE = /\bKeypair\b|fromSecretKey|secretKey|\.sign\(|partialSign|signMessage/;
    expect(shipped.filter((name) => KEY_USE.test(read(name)))).toEqual(['signer.ts']);
  });

  it('only configuration and startup code name the secret variable', () => {
    const users = shipped.filter((name) => /ATTESTER_SECRET_KEY/.test(read(name)));
    expect(users.sort()).toEqual(['config.ts', 'main.ts', 'startup.ts']);
    expect(read('main.ts').match(/ATTESTER_SECRET_KEY/g)).toHaveLength(1);
  });

  it('the signer can build only record_attestation', () => {
    const source = read('signer.ts');
    expect(source).toContain('recordAttestation(');
    expect(source).not.toMatch(
      /approveTask|resolveDispute|rotateKeys|expire|cancelTask|refundExpired/,
    );
  });

  it('has no network listener: nothing can ask this process to sign', () => {
    const LISTENER = /fastify|createServer|\.listen\(|express|node:http|node:net/;
    expect(shipped.filter((name) => LISTENER.test(read(name)))).toEqual([]);
  });

  it('executes nothing fetched from GitHub', () => {
    const EXECUTION = /child_process|\beval\(|new Function|\bexec\(|spawn\(|vm\./;
    expect(shipped.filter((name) => EXECUTION.test(read(name)))).toEqual([]);
  });
});
