// USDC amounts are bigint base units everywhere. Decimal text exists only at
// the edge: what a person types and what a person reads. No floating point.

export const USDC_DECIMALS = 6;
const UNIT = 10n ** BigInt(USDC_DECIMALS);
const U64_MAX = (1n << 64n) - 1n;

/** `"100"`, `"100.5"`, `"0.000001"` -> base units. `null` for anything else. */
export function parseUsdc(text: string): bigint | null {
  const match = /^(\d{1,14})(?:\.(\d{1,6}))?$/.exec(text.trim());
  if (match === null) return null;
  const whole = BigInt(match[1] ?? '0');
  const fraction = BigInt((match[2] ?? '').padEnd(USDC_DECIMALS, '0'));
  const amount = whole * UNIT + fraction;
  return amount > 0n && amount <= U64_MAX ? amount : null;
}

/** Base units -> `"97.50"`: always at least two decimals, never rounded. */
export function formatUsdc(amount: bigint | string): string {
  const value = typeof amount === 'string' ? BigInt(amount) : amount;
  const whole = value / UNIT;
  const fraction = (value % UNIT).toString().padStart(USDC_DECIMALS, '0');
  const trimmed = fraction.replace(/0+$/, '').padEnd(2, '0');
  return `${whole.toLocaleString('en-US')}.${trimmed}`;
}

/** Whole hours (1..8760) -> seconds. `null` for anything else. */
export function parseHours(text: string): bigint | null {
  if (!/^\d{1,4}$/.test(text.trim())) return null;
  const hours = BigInt(text.trim());
  return hours >= 1n && hours <= 8_760n ? hours * 3_600n : null;
}

export function formatDuration(seconds: bigint | string): string {
  const total = typeof seconds === 'string' ? BigInt(seconds) : seconds;
  if (total < 60n) return `${total.toString()} s`;
  if (total < 3_600n) return `${(total / 60n).toString()} min`;
  if (total < 172_800n) return `${(total / 3_600n).toString()} h`;
  return `${(total / 86_400n).toString()} d`;
}

/** Unix seconds -> local date and time, or a dash when unset. */
export function formatTime(unixSeconds: bigint | null): string {
  if (unixSeconds === null || unixSeconds === 0n) return '—';
  return new Date(Number(unixSeconds) * 1000).toLocaleString();
}

export function shortAddress(address: string): string {
  return address.length <= 12 ? address : `${address.slice(0, 4)}…${address.slice(-4)}`;
}
