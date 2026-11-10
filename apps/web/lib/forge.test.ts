import { describe, expect, it } from 'vitest';
import { forgeClosed } from './forge';

// /forge never walks a visitor through every step to fail at the last one: while the factory is not on chain the first
// screen says so and offers no forging.
describe('whether the forge stands closed', () => {
  it('follows the network’s statement until the factory answers, so the first frame is already right', () => {
    expect(forgeClosed(false, null)).toBe(true);
    expect(forgeClosed(true, null)).toBe(false);
  });

  it('is closed when the chain says there is no factory, whatever the statement says', () => {
    expect(forgeClosed(true, 'refused')).toBe(true);
    expect(forgeClosed(false, 'refused')).toBe(true);
  });

  it('is closed while the factory has not published the mask code', () => {
    expect(forgeClosed(true, { published: false })).toBe(true);
    expect(forgeClosed(false, { published: false })).toBe(true);
  });

  it('opens the moment the factory answers with its mask code published, even before the statement is changed', () => {
    expect(forgeClosed(true, { published: true })).toBe(false);
    expect(forgeClosed(false, { published: true })).toBe(false);
  });

  it('keeps to the statement when no RPC answers: a factory that is there is only out of reach', () => {
    expect(forgeClosed(true, 'silent')).toBe(false);
    expect(forgeClosed(false, 'silent')).toBe(true);
  });
});
