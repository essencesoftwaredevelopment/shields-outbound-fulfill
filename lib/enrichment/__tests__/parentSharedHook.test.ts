import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const parentPath = fileURLToPath(
  new URL('../../../workflows/enrichment-parent.ts', import.meta.url)
);

describe('enrichment parent completion hook (contract)', () => {
  const source = readFileSync(parentPath, 'utf8');

  it('uses one shared createHook consumed with for await', () => {
    assert.match(
      source,
      /using completionHook = createHook<ChildCompletionPayload>\(\)/
    );
    assert.match(source, /for await \(const payload of completionHook\)/);
    assert.equal(
      [...source.matchAll(/createHook</g)].length,
      1,
      'must create exactly one completion hook for the parent run'
    );
  });

  it('does not Promise.race per-child completion hooks', () => {
    assert.doesNotMatch(source, /await Promise\.race/);
    assert.doesNotMatch(source, /inFlightHooks/);
  });
});
