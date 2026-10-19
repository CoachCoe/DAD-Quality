# Move 3 — cross-feature integration verification (FEAT-001 ∩ FEAT-002)

Worktree: `/Users/shawncoe/Documents/dev/DAD/atm/.worktrees/move3-adapter-split`
Branch: `feat/adapter-interface`
Iteration: 1 (no `verdict.json` present — this is the first cross-feature integration pass).

Scope: verify the seams between FEAT-001 (ProvisioningAdapter base + formal
target-adapter interface) and FEAT-002 (DAD relocation into `src/targets/dad/`,
benchmark + registry relocation under `src/targets/`, re-export shims, and the
argv/digest/cookie guards). No integration breakage was found; no fixes required.

## Commands and results (all re-run this iteration)

### `npm run lint`
Clean. `biome check --error-on-warnings .` — "Checked 84 files in 36ms. No fixes applied." 0 errors, 0 warnings. Exit 0.

### `npm test`  (`node --test test/*.test.js`)
Fully green with UNCHANGED test imports — every deep import (`../src/dad.js`,
`../src/benchmark-adapter.js`, `../src/targets.js`) resolves through the
re-export shims.

```
ℹ tests 123
ℹ pass  123
ℹ fail  0
```

Baseline is 109 pass (context.json: dev with model keys unset, no Docker). The
split adds the new base/argv/conformance coverage on top of the engine suites,
reaching 123 pass / 0 fail. Infra-gated suites (`test/*.browser.js`,
`test/fixture.postgres.js`) are intentionally NOT run here (no Docker/Chromium/
model keys) and remain resolvable via the shims for the post-merge orchestrator.

New guard coverage over baseline:
- `test/targets.test.js` — pinned policy digest + 869-char JSON snapshot + registry identity (`dad` → `impactgraph`).
- `test/dad-argv.test.js` (8 tests) — argv snapshots for database-start (acceptance + exploration), migrations, test-migrations, suite(api-tests)/suite(web-tests), deploy, cleanup down, and sql/exec.
- `test/interface-conformance.test.js` (2 tests) — dad + benchmark interface-surface conformance.

Explicit guard run: `node --test test/dad-argv.test.js test/interface-conformance.test.js test/targets.test.js test/benchmark-adapter.test.js` → 14 pass / 0 fail.

## Byte-identical proof (end-to-end)

### `git diff dev -- src/runner.js`
Prints NOTHING — `src/runner.js` is byte-identical to `dev`. It stays on the
`./dad.js` shim (line 4: `import { DadAdapter } from './dad.js';`), so zero lines changed.

```
===RUNNER DIFF (expect empty)===
===END DIFF===
```

### Policy digest + JSON length
```
node -e "import('./src/discovery-runner.js').then(m=>{const d=m.discoveryPolicy('dad');console.log(d.digest, JSON.stringify(d.definition).length)})"
=> be91648ac06f7508faf9148c339d25e0a704f4b7c61c7918b8e7b23892113954 869
```
Matches the pinned digest and the 869-char definition exactly.

### Engine files unchanged vs `dev`
`git diff dev -- src/<file>` is empty for every engine module:
`discovery.js`, `discovery-browser.js`, `experiments.js`, `experiment-contract.js`,
`application-memory.js`, `source-reader.js`, `core.js`, `model-provider.js` — all UNCHANGED.

### Compatibility aliases intact
- Cookie `dad_donor_session` present in `discovery-browser.js`, `targets/dad/config.js`, `targets/dad/sql.js`, `performance.js` — unchanged.
- impactgraph identifiers intact: registry `policyId: 'impactgraph-discovery'`, `adapterId: 'impactgraph'` (`src/targets/index.js`); `runner.js` adapter `'impactgraph'`; default policy `policies/impactgraph-local.json`.

### Argv guards for every rewritten site
Every `composeRun`/`execSql`-rewritten call site has a passing argv guard:
- database-start (acceptance: `...postgres test-postgres`; exploration: `...postgres`)
- migrations (`run --rm -T migrate`, failureStatus failed)
- test-migrations (acceptance, templated `DONOR_GO_DATABASE_URL`)
- suite `api-tests` and suite `web-tests` (`run --rm -T <name>`, timeout 900_000)
- deploy (`up -d --wait --wait-timeout 120 api web ingress`, timeout 180_000)
- cleanup down (`down --volumes --remove-orphans --timeout 10`, timeout 90_000)
- sql/exec (`exec -T postgres psql -X -v ON_ERROR_STOP=1 -U atm_owner -d dad_atm -At`)

The `composeRun` helper prepends `['compose','-p',this.id,'-f',this.file]` and
appends the rest verbatim; `execSql` binds `-X -v ON_ERROR_STOP=1` (both load-bearing).

## Seam / structural checks
- Shims are thin re-exports: `src/targets.js` → `./targets/index.js`; `src/dad.js` → `{ DadAdapter }` from `./targets/dad/index.js` + `{ composeDefinition }` from `./targets/dad/compose.js`; `src/benchmark-adapter.js` → `./targets/benchmark.js`.
- Target layout present: `src/targets/{index.js,base.js,benchmark.js}` and `src/targets/dad/{index.js,config.js,compose.js,sql.js}`.
- No file under `src/targets/` imports a shim (`../targets.js`, `../dad.js`, `../benchmark-adapter.js`) — grep returns none.
- Registry importers repointed to `./targets/index.js`: `discovery-runner.js`, `cli.js`, `policy.js`. `src/runner.js` left on the `./dad.js` shim (unchanged).
- All src modules import-resolve cleanly (shims + relocated modules + repointed importers) — 14/14 OK via dynamic-import smoke.
- Benchmark adapter (`src/targets/benchmark.js`) conforms to the interface and does NOT extend the base.

## Not runnable here (stated, not faked)
Full DAD Docker provisioning and the Playwright `*.browser.js` suites are NOT
runnable in this environment (no Docker, no Chromium, no model keys). Byte-identity
for the rewritten DAD provisioning call sites is proven instead by the argv-snapshot
guards (stubbed `logged`/`compose`), the pinned policy digest/JSON snapshot, the
unchanged engine suite, and the empty `runner.js` diff.

## Verdict
Lint clean, 123/123 tests green, runner.js diff empty, policy digest and 869-char
JSON intact, cookie and impactgraph aliases intact, engine files unchanged, and
every rewritten call site guarded. Cross-feature seams between FEAT-001 and
FEAT-002 are sound — no integration breakage, no fixes needed this iteration.
