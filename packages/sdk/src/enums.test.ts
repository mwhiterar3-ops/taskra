import { describe, expect, it } from 'vitest';
import {
  canonicalName,
  DISPUTE_RESOLUTIONS,
  idlVariantName,
  isTerminalState,
  outcomeFromIdl,
  OUTCOMES,
  TASK_STATES,
  taskStateFromIdl,
  TERMINAL_TASK_STATES,
} from './enums.js';
import { TaskraSdkError } from './errors.js';
import { IDL } from './generated/idl.js';

function idlVariants(name: string): string[] {
  const definition = IDL.types.find((type) => type.name === name);
  if (definition?.type.kind !== 'enum') throw new Error(`${name} is not an enum in the IDL`);
  return definition.type.variants.map((variant) => variant.name);
}

describe('enum parity with the IDL', () => {
  it.each([
    ['TaskState', TASK_STATES],
    ['Outcome', OUTCOMES],
    ['DisputeResolution', DISPUTE_RESOLUTIONS],
  ] as const)('%s has the same variants in the same order', (name, values) => {
    // Order matters: the variant index is the on-chain byte.
    expect(idlVariants(name).map(canonicalName)).toEqual([...values]);
    expect(values.map(idlVariantName)).toEqual(idlVariants(name));
  });

  it('uses the canonical state names of docs/13-DECISIONS.md §2.1', () => {
    expect(TASK_STATES).toEqual([
      'OPEN',
      'ACCEPTED',
      'SUBMITTED',
      'UNDER_REVIEW',
      'DISPUTED',
      'SETTLED',
      'REFUNDED',
      'CANCELLED',
    ]);
  });

  it('maps IDL variants to canonical names', () => {
    expect(taskStateFromIdl('UnderReview')).toBe('UNDER_REVIEW');
    expect(outcomeFromIdl('DisputeExpiredForDeveloper')).toBe('DISPUTE_EXPIRED_FOR_DEVELOPER');
    expect(() => taskStateFromIdl('Funded')).toThrow(TaskraSdkError);
    expect(() => outcomeFromIdl('Split')).toThrow(TaskraSdkError);
  });

  it('knows the three terminal states', () => {
    expect(TERMINAL_TASK_STATES).toEqual(['SETTLED', 'REFUNDED', 'CANCELLED']);
    expect(TASK_STATES.filter(isTerminalState)).toEqual(['SETTLED', 'REFUNDED', 'CANCELLED']);
  });
});
