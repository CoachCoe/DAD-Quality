# Move 3 adapter-split — final finalization summary

Worktree: `/Users/shawncoe/Documents/dev/DAD/atm/.worktrees/move3-adapter-split`
Branch: `feat/adapter-interface`
Verdict: **APPROVED** (`.agents/tasks/verdict.json`, `findings: []`)

## Clean / mergeable state

`git status -sb` shows a clean tree — all work is committed (the convergence-loop
task-tracking artifacts under `.agents/tasks/` were committed in the finalization
commit, matching the convention used by move2 / move3-verification).

## Commit hashes on feat/adapter-interface (ahead of dev)

- `720da1e` refactor: add ProvisioningAdapter base + formal interface
- `c697c78` refactor: split DadAdapter into targets/dad + relocate benchmark/registry behind shims
- `7e491ee` chore: mark FEAT-002 completed with verification findings
- `dc44e32` docs: record move3 cross-feature integration verification
- `f09d1c3` chore: record move3 convergence task artifacts and final summary (finalization)

(`dev` tip is `7a4a255`; branch base is `781b426` origin/dev.)

## Verification results (re-run live in this finalization pass)

- **Lint**: `npm run lint` → `biome check --error-on-warnings .` clean. Checked 85 files, 0 errors / 0 warnings. Exit 0.
- **Tests**: `npm test` → `node --test test/*.test.js` → **123 pass / 0 fail**, 0 cancelled / 0 skipped / 0 todo.
- **runner.js byte-identity**: `git diff dev -- src/runner.js` → **EMPTY** (confirmed). It stays on the `./dad.js` shim, so zero lines changed.
- **Policy digest**: `discoveryPolicy('dad').digest` = `be91648ac06f7508faf9148c339d25e0a704f4b7c61c7918b8e7b23892113954` — **matches** the pinned value exactly.

## New / moved files and shims

New (`A` vs dev):
- `src/targets/base.js` — `ProvisioningAdapter` base + formal-interface JSDoc
- `src/targets/dad/index.js` — `DadAdapter extends ProvisioningAdapter` (composeRun/execSql/freePort rewrites)
- `src/targets/dad/compose.js` — `composeDefinition` + nginx template (byte-identical move)
- `src/targets/dad/sql.js` — DAD SQL builders (byte-identical strings)
- `src/targets/dad/config.js` — DAD data (files, images, services, db/roles, cookie)
- `src/targets/benchmark.js` — benchmark adapter relocated verbatim (does NOT extend base)
- `src/targets/index.js` — registry relocated (value-identical; only import paths changed)
- `test/base.test.js`, `test/dad-argv.test.js`, `test/interface-conformance.test.js` — new tests
- `.agents/tasks/features/FEAT-001.json`, `FEAT-002.json`, `move3-verification.md` — docs

Modified (`M` vs dev):
- `src/benchmark-adapter.js` → shim: `export * from './targets/benchmark.js';`
- `src/targets.js` → shim: `export * from './targets/index.js';`
- `src/dad.js` → shim: re-exports `{ DadAdapter }` from `./targets/dad/index.js` + `{ composeDefinition }` from `./targets/dad/compose.js`
- `src/cli.js`, `src/discovery-runner.js`, `src/policy.js` — registry import repointed to `./targets/index.js`
- `test/targets.test.js` — extended with digest + 869-char JSON snapshot + registry identity

Shims (3): `src/dad.js`, `src/targets.js`, `src/benchmark-adapter.js` — all thin re-exports keeping existing deep imports (and `src/runner.js`) resolving unchanged.

## Five fold-ins — all present

1. **suite argv guards + a guard per rewritten site** — `test/dad-argv.test.js` guards `suite('api-tests')` AND `suite('web-tests')`, plus every other composeRun/execSql-rewritten call site.
2. **deploy health-exec + replay stay plain `compose`** (no extra guard) — honored in `targets/dad/index.js`.
3. **`this.freePort()` base method** — `docker()` calls `await this.freePort()`; base defines it.
4. **`*-checks` build citation (mode-gated `build-${service}-checks`)** — present, matching dev.
5. **runner-produced discovery/journey evidence noted in the interface doc** — present in `base.js` JSDoc.

## Full argv-guard set (incl. suite) — all passing

- database-start (acceptance: `...postgres test-postgres`; exploration: `...postgres`)
- migrations (`run --rm -T migrate`, `failureStatus:'failed'`)
- test-migrations (acceptance, templated `DONOR_GO_DATABASE_URL`)
- **suite `api-tests` AND suite `web-tests`** (`run --rm -T <name>`, timeout 900_000)
- deploy (`up -d --wait --wait-timeout 120 api web ingress`, timeout 180_000)
- cleanup down (`down --volumes --remove-orphans --timeout 10`, timeout 90_000)
- sql/exec (`exec -T postgres psql -X -v ON_ERROR_STOP=1 -U atm_owner -d dad_atm -At`)

## NOT run here (needs Docker / live model) — stated, not faked

- Full DAD Docker provisioning (compose up/migrate/suite/deploy/cleanup against real containers).
- Playwright browser suites (`test/*.browser.js`) — no Chromium.
- Real Postgres fixture (`test/fixture.postgres.js`) — no Docker.
- Any live-model discovery run — no model API keys.

Byte-identity for the rewritten provisioning call sites is instead proven by the
argv-snapshot guards (stubbed `logged`/`compose`), the pinned policy digest/JSON
snapshot, the unchanged engine suite, and the empty `runner.js` diff. These
infra-gated suites remain resolvable via the shims for the post-merge orchestrator.

## Orchestrator handoff

NOT merged into dev, NOT pushed, worktree NOT deleted — the human orchestrator
handles the merge/cleanup.
