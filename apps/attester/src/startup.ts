import type { AttesterChain } from './chain.js';
import type { AttestationSigner } from './signer.js';

/**
 * Throws unless the configured key is the attester recorded in the Platform
 * account. A key the platform does not recognise can never attest, so the
 * service refuses to run with one rather than failing every transaction.
 */
export async function assertConfiguredAttester(
  chain: AttesterChain,
  signer: AttestationSigner,
): Promise<void> {
  const expected = await chain.getPlatformAttester();
  if (!expected.equals(signer.publicKey)) {
    throw new Error(
      `ATTESTER_SECRET_KEY is for ${signer.publicKey.toBase58()}, but the Platform account ` +
        `records ${expected.toBase58()} as its attester`,
    );
  }
}
