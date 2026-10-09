let passed = 0;

export function passedChecks(): number {
  return passed;
}

export function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

export function note(message: string): void {
  console.log(`  ${message}`);
}

function show(value: unknown): string {
  return typeof value === 'bigint' ? `${value.toString()}n` : JSON.stringify(value);
}

/** Fails the run unless `actual` equals `expected` (compared structurally). */
export function check(what: string, actual: unknown, expected: unknown): void {
  if (show(actual) !== show(expected)) {
    throw new Error(`CHECK FAILED: ${what}: expected ${show(expected)}, got ${show(actual)}`);
  }
  passed += 1;
  console.log(`      ok: ${what}`);
}

export function checkTrue(what: string, condition: boolean): void {
  check(what, condition, true);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls `read` until `done` accepts its value. This waits for an observable
 * condition (finality, a verification result, the chain clock), never for a
 * fixed amount of time.
 */
export async function until<Value>(
  what: string,
  read: () => Promise<Value>,
  done: (value: Value) => boolean,
  timeoutMs = 120_000,
): Promise<Value> {
  const started = Date.now();
  for (;;) {
    const value = await read();
    if (done(value)) {
      note(`reached: ${what} (${String(Math.round((Date.now() - started) / 100) / 10)} s)`);
      return value;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`TIMED OUT waiting for: ${what}; last value ${show(value)}`);
    }
    await sleep(1_000);
  }
}
