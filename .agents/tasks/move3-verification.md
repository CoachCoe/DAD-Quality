# Move 3 — FEAT-002 verification

Worktree: `/Users/shawncoe/Documents/dev/DAD/atm/.worktrees/move3-adapter-split`
Branch: `feat/adapter-interface`

## Commands and results

### `npm run lint`
Clean. `biome check --error-on-warnings .` — "Checked 84 files. No fixes applied." 0 errors, 0 warnings.

### `npm test`
Fully green with UNCHANGED test imports (every deep import — `../src/dad.js`, `../src/benchmark-adapter.js`, `../src/targets.js` — resolves via the re-export shims).

```
tests 123
pass  123
fail  0
```

Baseline after FEAT-001 was 113 pass. FEAT-002 adds 10 new guard assertions:
- `test/targets.test.js` — pinned digest + 869-char JSON snapshot (folded into the existing byte-identical test).
- `test/dad-argv.test.js` (8 tests) — argv snapshots for database-start (acceptance + exploration), migrations, test-migrations, suite(api-tests)/suite(web-tests), deploy, cleanup down, and sql/exec.
- `test/interface-conformance.test.js` (2 tests) — dad + benchmark interface-surface conformance.

Coverage was NOT deleted.

### `git -C .../move3-adapter-split diff dev -- src/runner.js`
Prints NOTHING (empty result pasted below between the markers):

```
===RUNNER DIFF (expect empty)===
===END DIFF===
```

`src/runner.js` is byte-identical to `dev` — it stays on the `./dad.js` shim, so zero lines changed.

### Policy digest + JSON length
```
node -e "import('./src/discovery-runner.js').then(m=>{const d=m.discoveryPolicy('dad');console.log(d.digest, JSON.stringify(d.definition).length)})"
=> be91648ac06f7508faf9148c339d25e0a704f4b7c61c7918b8e7b23892113954 869
```
Matches the pinned digest and the 869-char definition exactly.

### Benchmark smoke
`node --test test/benchmark-adapter.test.js` — 2 pass, 0 fail. Relocated adapter (`src/targets/benchmark.js`) provisions the in-process loopback server and resolves via the shim; no Docker / no model key required.

## Not runnable here (stated, not faked)
Full DAD Docker provisioning (snapshot/docker/build/database/deploy against real containers) and the Playwright `*.browser.js` suites are NOT runnable in this environment (no Docker, no Chromium, no model keys). Byte-identity for the rewritten DAD provisioning call sites is proven instead by the argv-snapshot guards (stubbed `command`/`logged`/`compose`), the policy digest/JSON snapshot, and the unchanged unit suite. The infra-gated suites remain resolvable via the shims and are run post-merge by the orchestrator.

## Structural checks
- `src/targets/{index.js,base.js,benchmark.js}` and `src/targets/dad/{index.js,config.js,compose.js,sql.js}` exist.
- `src/targets.js`, `src/dad.js`, `src/benchmark-adapter.js` are thin re-export shims.
- Enforced: no file under `src/targets/` imports a shim (`../targets.js`, `../dad.js`, `../benchmark-adapter.js`) — verified by grep (no matches).
- Registry importers repointed to `./targets/index.js`: `discovery-runner.js`, `cli.js`, `policy.js`. `src/runner.js` left unchanged.
- Cookie `dad_donor_session` and the `impactgraph`/`impactgraph-discovery` identifiers unchanged.
