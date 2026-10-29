import test from 'node:test';
import assert from 'node:assert/strict';
import { auditAccessibility } from '../src/accessibility.js';

// The audit degrades gracefully: when axe cannot run against the given target it
// returns null (the evaluator then treats a11y_clean as inconclusive, never a
// failure), rather than throwing and crashing discovery.
test('auditAccessibility returns null when the audit cannot run', async () => {
  // A bogus "page" makes AxeBuilder(...).analyze() throw; the helper swallows it.
  const result = await auditAccessibility(/** @type {any} */ ({}));
  assert.equal(result, null);
});
