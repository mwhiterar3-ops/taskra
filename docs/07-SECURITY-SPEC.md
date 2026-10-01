# Taskra — Security Specification

## Wallet

- Never request or store seed phrases/private keys.
- Never custody user funds in the backend.
- Wallet ownership must be cryptographically authenticated.
- Never trust a wallet address merely because it was supplied in JSON.

## Solana

- Validate account ownership.
- Validate PDA relationships.
- Validate token mint.
- Validate token accounts.
- Validate authority.
- Validate state transitions.
- Prevent double settlement.
- Prevent unauthorized withdrawal.
- Prevent replay/duplicate processing where applicable.

## Backend

- Validate every input.
- Authorize every mutation.
- Use parameterized database queries/ORM safely.
- Rate-limit public endpoints and GitHub verification.
- Verify GitHub webhook signatures if webhooks are used.
- Never log secrets.
- Never commit .env or private keys.

## Money

All monetary arithmetic must use integer token base units.

No JavaScript floating point for balances or settlement calculations.

## Secrets

Secrets must exist only in environment/configuration systems, never source code.
