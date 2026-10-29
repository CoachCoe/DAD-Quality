import test from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../src/cli.js';

// Phase 2: the CLI is codebase-agnostic. --target/--repo are first-class; only the
// real constraints remain (validation is dad-only, benchmark is the sole repo-less target).

test('run is rejected for non-dad targets because only dad ships an acceptance policy', async () => {
  await assert.rejects(
    main(['run', '--repo', '/path/to/repo', '--target', 'generic-web']),
    /release validation.*only for --target dad/i,
  );
});

test('explore on a non-dad target is accepted past the target guard (fails later for other reasons)', async () => {
  // generic-web explore is allowed; it will fail downstream (no model/config), never on the DAD-only guard.
  await assert.rejects(main(['explore', '--repo', '/path/to/repo', '--target', 'generic-web']), error => {
    assert.doesNotMatch(error.message, /only for --target dad/i);
    return true;
  });
});

test('an unknown target errors before provisioning', async () => {
  await assert.rejects(main(['explore', '--repo', '/path/to/repo', '--target', 'nope']), /Unknown target: nope/);
});

test('--repo is required for dad and generic-web but not benchmark', async () => {
  await assert.rejects(main(['explore', '--target', 'generic-web']), /--repo .*only --target benchmark needs no repo/i);
  await assert.rejects(main(['run']), /--repo/);
  // benchmark needs no repo: it passes the repo guard and fails later (model config).
  await assert.rejects(main(['explore', '--target', 'benchmark']), error => {
    assert.doesNotMatch(error.message, /needs no repo/i);
    return true;
  });
});

test('--config is rejected unless the target is generic-web', async () => {
  await assert.rejects(
    main(['explore', '--repo', '/path/to/repo', '--target', 'dad', '--config', 'atm.config.json']),
    /--config applies only to --target generic-web/,
  );
});

test('usage error names a generic repo path, not DAD-Main', async () => {
  await assert.rejects(main(['bogus']), error => {
    assert.match(error.message, /--repo \/path\/to\/repo/);
    assert.doesNotMatch(error.message, /DAD-Main/);
    return true;
  });
});
