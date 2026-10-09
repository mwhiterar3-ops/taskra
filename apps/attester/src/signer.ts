// The attester key. This file is the only place in Taskra where a private key
// is loaded, and the only thing it can sign is a transaction it built itself
// containing exactly one `record_attestation` instruction. It exposes no way
// to sign a message, another instruction, or a transaction built elsewhere.

import { Keypair, type PublicKey } from '@solana/web3.js';
import { buildUnsignedTransaction, recordAttestation, type TaskraConfig } from '@taskra/sdk';
import bs58 from 'bs58';

export interface AttestationRequest {
  readonly task: PublicKey;
  readonly evidenceHash: Uint8Array;
  readonly submissionNonce: bigint;
  readonly recentBlockhash: string;
}

export interface SignedAttestation {
  /** The transaction signature, known before the transaction is sent. */
  readonly signature: string;
  readonly serialized: Uint8Array;
}

export interface AttestationSigner {
  readonly publicKey: PublicKey;
  signAttestation(request: AttestationRequest): SignedAttestation;
}

/** `secretKeyJson` is the JSON array of 64 bytes that `solana-keygen` writes. */
export function createAttestationSigner(
  secretKeyJson: string,
  config: TaskraConfig,
): AttestationSigner {
  // Held in this closure only: never returned, logged or attached to an object.
  const keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secretKeyJson) as number[]));

  return {
    publicKey: keypair.publicKey,
    signAttestation(request) {
      const transaction = buildUnsignedTransaction({
        feePayer: keypair.publicKey,
        recentBlockhash: request.recentBlockhash,
        instructions: [
          recordAttestation(config, {
            attester: keypair.publicKey,
            task: request.task,
            evidenceHash: request.evidenceHash,
            submissionNonce: request.submissionNonce,
          }),
        ],
      });
      transaction.sign([keypair]);
      const [signature] = transaction.signatures;
      if (signature === undefined) throw new Error('the transaction has no signature slot');
      return { signature: bs58.encode(signature), serialized: transaction.serialize() };
    },
  };
}
