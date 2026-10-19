# Move 3 implementation plan — adapter split (generic provisioning base + `targets/dad` + formal interface)

Worktree (working dir for every step): `/Users/shawncoe/Documents/dev/DAD/atm/.worktrees/move3-adapter-split`. Branch `feat/adapter-interface`. ESM, Node ≥ 22, Biome-clean. All git commands use `git -C /Users/shawncoe/Documents/dev/DAD/atm/.worktrees/move3-adapter-split …`. Use absolute paths; relative paths resolve against the parent workspace, not the worktree.

This plan implements the APPROVED design at `.agents/tasks/move3-adapter-interface-design.md`. The design is authoritative on architecture — this plan sequences it and folds in the five outstanding review items (`.agents/tasks/design-review.json`) as MANDATORY requirements. Do not re-decide the architecture.

## Verified baseline facts (checked in the worktree before planning)

- `git -C … diff dev` is empty; worktree clean except untracked `.agents/tasks/*` design docs.
- `npm run lint` → clean (70 files). `npm test` → 109 pass, 0 fail, with model keys unset and no Docker.
- `discoveryPolicy('dad').digest` === `be91648ac06f7508faf9148c339d25e0a704f4b7c61c7918b8e7b23892113954`; `JSON.stringify(definition)` is 869 chars and equals the pinned body in the design §8.6(a). Confirmed via `node -e "import('./src/discovery-runner.js').then(m=>{const d=m.discoveryPolicy('dad');console.log(d.digest, JSON.stringify(d.definition).length)})"`.
- `src/dad.js` call-site line numbers (authoritative locators are the unique label strings; lines may drift): `freePort` def `:12`, bare call `:219`; `database-start` `:299`; `migrations` `:315`; `test-migrations` `:327`; `suite` `:358`; `deploy` `:373`; `cleanup` down `:586`; `build-${service}-checks` label `:267` (mode guard `:266`) — **fold-in #4: the design's "264-272" citation is corrected to 266-272**.
- Deep test imports that must keep resolving unchanged: `test/adapter.test.js` and `test/fixture.postgres.js` import `{ composeDefinition, DadAdapter }` / `{ DadAdapter, composeDefinition }` from `../src/dad.js`; `test/experiments.test.js` imports `{ DadAdapter }` from `../src/dad.js`; `test/benchmark-adapter.test.js` imports `{ BenchmarkAdapter }` from `../src/benchmark-adapter.js` and `{ resolveTarget }` from `../src/targets.js`; `test/targets.test.js` imports `{ resolveTarget, isRegisteredAdapter }` from `../src/targets.js`.
- Production importers: `runner.js` imports `{ DadAdapter } from './dad.js'` (line 4) — **must end at zero changed lines**. `cli.js`, `discovery-runner.js`, `policy.js` import `./targets.js` (registry) — these are repointed to `./targets/index.js`.

## The five mandatory fold-ins (from `design-review.json`)

1. **(MEDIUM)** `suite` is in the composeRun rewrite set, so it MUST have an argv guard. Add tests driving `suite(result,'api-tests')` and `suite(result,'web-tests')` against a stubbed command runner, asserting each recorded argv equals the pinned literal `['compose','-p',<id>,'-f',<file>,'run','--rm','-T','api-tests']` and `[... 'web-tests']`. Every method touched by the composeRun/execSql rewrite MUST have a matching argv guard.
2. **(NIT)** Impl notes must state explicitly: `deploy`'s readiness health-exec `this.compose(['exec','-T','web','node','-e',…])` and `discoveryReplayFixture`'s stop/start/pg_dump calls remain plain `this.compose(...)` (pure relocation, no argv rewrite); `compose`'s prepend correctness is proven transitively by the `sql`/exec argv guard. No new guard for those.
3. **(NIT)** Pick and state the concrete `freePort` form. **Decision: `this.freePort()` base method on `ProvisioningAdapter`.** Rationale: `docker()` already calls it on an instance that is `this`; a base method keeps the symbol resolution local to the class and avoids a second module import in `dad/index.js`. Mechanical symbol-resolution change; output is a random port, not snapshot-testable.
4. **(NIT)** Fix the `*-checks` image-build citation from 264-272 to 266-272; rely on the `build-${service}-checks` label as the authoritative locator.
5. **(NIT)** Interface §1 must note: `discovery`-phase evidence (`discovery.json`, `discovery-trace.zip`) and acceptance-only journey evidence are produced by the RUNNER/engine, not the adapter. The adapter owns only the five provisioning phases' evidence (`candidate.json`; `docker.log`,`compose-version.log`; `build-api.log`,`build-web.log`; `migrations.log`,`test-migrations.log`; `readiness.log`) plus `cleanup.log`.

## Hard byte-identical invariants the plan must prove

- `discoveryPolicy('dad')` emits id `impactgraph-discovery`, adapter `impactgraph`, digest `be91648ac06f7508faf9148c339d25e0a704f4b7c61c7918b8e7b23892113954`, and 869-char definition JSON equal to the pinned body.
- DAD cookie stays `dad_donor_session`.
- `git -C … diff dev -- src/runner.js` is EMPTY (zero changed lines) — the `src/dad.js` shim guarantees this.
- Every composeRun/execSql-rewritten DAD call site has a passing argv-snapshot test equal to its pinned pre-refactor literal, including `suite` (fold-in #1).
- `impactgraph`/`impactgraph-discovery` are INTENTIONAL compatibility aliases — never renamed.

Note on scope here: full DAD Docker provisioning is too slow/unavailable in this environment. The byte-identical proof relies on argv-snapshot guards (stubbed `command`) + the unit suite + the policy digest/JSON snapshot. Infra-gated suites (`test:fixture`, `*.browser.js`) are NOT run in this phase but MUST stay resolvable via the shims; the orchestrator runs them post-merge.

---

## Ordered implementation units

- [ ] 1. Create `src/targets/base.js`: formal-interface JSDoc `@typedef`s (Actor, Fixture, adapter contract per design §1, including the fold-in #5 note that discovery/journey evidence is runner-produced) plus the `ProvisioningAdapter` base class. Move the generic machinery from `dad.js` unchanged in behavior: `freePort` as a `this.freePort()` base method (fold-in #3), `logged(result,label,binary,args,options)`, `compose(args,options)`, the new `composeRun(result,label,args,options)` helper that prepends EXACTLY `['compose','-p',this.id,'-f',this.file]` then appends `args` verbatim, the `execSql({service,user,db},query)` helper with argv pinned to `['exec','-T',service,'psql','-X','-v','ON_ERROR_STOP=1','-U',user,'-d',db,'-At']` (only service/user/db parameterized; `-X -v ON_ERROR_STOP=1` load-bearing, never dropped/reordered), the git-archive snapshot skeleton (required-files list injected by caller), image build/inspect helper (mode branching NOT absorbed — stays in DAD), compose up/down wrappers, `created`/`id`/`signal`/`run` bookkeeping, and the generic cleanup flow. No adapter wired yet.
      Files: `src/targets/base.js`
      Verify: `npm run lint` clean. Add `test/base.test.js` unit tests: `logged` writes `${label}.log` on both success and failure (fake `command`, in-memory `run.evidence`); `composeRun` prepends exactly `['compose','-p',id,'-f',file]`; `execSql` emits the pinned psql argv. `npm test` green.

- [ ] 2. Create `src/targets/dad/` package and move DAD-specific code out of `dad.js`. `compose.js` ← `composeDefinition(...)` + nginx template (byte-identical). `sql.js` ← all fixture/verification/projection/performance SQL as exported builders (byte-identical strings). `config.js` ← required-files list, pinned `POSTGRES`/`NGINX` images, service names, env var names, db names (`dad_atm`/`donor_go`), roles (`dad_api`→`atm_api`, `dad_staff_cli`→`atm_staff`, owner `atm_owner`), cookie name `dad_donor_session`. `index.js` ← `DadAdapter extends ProvisioningAdapter`, binding config into base helpers. Apply the binding rewrite rule: each inlined `logged(result,LABEL,'docker',['compose','-p',this.id,'-f',this.file,...REST],OPTS)` → `composeRun(result,LABEL,[...REST],OPTS)` with REST copied character-for-character (including the `...(mode==='exploration'?[]:['test-postgres'])` spread in `database-start` and the templated `-e DONOR_GO_DATABASE_URL=…` element in `test-migrations`). Rewrite `sql(query)` → `execSql({service:'postgres',user:'atm_owner',db:'dad_atm'},query)`. Keep the exploration-vs-acceptance mode branching and BOTH summary-string variants verbatim in `dad/index.js`. Keep the §2 validation-only methods verbatim (`invitation`, `verifyStaff`, `donorFixture`, `verifyDonor`, `performanceFixture`, `suite`, `discoveryState`, `sql`). `deploy`'s readiness health-exec and `discoveryReplayFixture`'s stop/start/pg_dump stay plain `this.compose(...)` (fold-in #2 — pure relocation). `freePort()` call site becomes `this.freePort()` (fold-in #3). Leave `src/dad.js` in place as the monolith is emptied (shim added in unit 5).
      Files: `src/targets/dad/compose.js`, `src/targets/dad/sql.js`, `src/targets/dad/config.js`, `src/targets/dad/index.js`
      Verify: `npm run lint` clean. Temporarily import `dad/index.js` directly in a scratch run of `adapter.test.js`/`experiments.test.js` DAD cases (or run them after unit 5's shim lands). `npm test` green once shim is in place.

- [ ] 3. Relocate the benchmark adapter to `src/targets/benchmark.js` verbatim (it does NOT extend `ProvisioningAdapter`). Update its internal import paths for the new depth (`../discovery-benchmark.js`, `../core.js`).
      Files: `src/targets/benchmark.js`
      Verify: `npm run lint` clean; `npm test` green after unit 5's shim lands (test still imports `../src/benchmark-adapter.js`).

- [ ] 4. Move the registry to `src/targets/index.js` — the `targets`/`resolveTarget`/`isRegisteredAdapter` code unchanged in value, importing `./dad/index.js` and `./benchmark.js`.
      Files: `src/targets/index.js`
      Verify: `npm run lint` clean.

- [ ] 5. Wire importers and add the three compatibility shims. Repoint registry importers `discovery-runner.js`, `cli.js`, `policy.js` from `./targets.js` to `./targets/index.js` (mechanical, zero behavioral change). LEAVE `src/runner.js` UNCHANGED (stays on `./dad.js`). Replace the three old module files with thin re-export shims: `src/targets.js` → `export * from './targets/index.js';`; `src/dad.js` → `export { DadAdapter } from './targets/dad/index.js'; export { composeDefinition } from './targets/dad/compose.js';`; `src/benchmark-adapter.js` → `export * from './targets/benchmark.js';`. Enforce the rule that no file under `src/targets/` imports a shim (`../targets.js`, `../dad.js`, `../benchmark-adapter.js`) — they import real modules directly (keeps the import graph an acyclic DAG, no circular-re-export `undefined`-export hazard).
      Files: `src/discovery-runner.js`, `src/cli.js`, `src/policy.js`, `src/targets.js`, `src/dad.js`, `src/benchmark-adapter.js`
      Verify: `npm test` green with UNCHANGED test imports (all deep imports resolve through shims). `git -C … diff dev -- src/runner.js` prints NOTHING (zero changed lines). `npm run lint` clean.

- [ ] 6. Add the byte-identical guards + interface-conformance test.
      **(a) Policy digest + full-JSON snapshot** in `test/targets.test.js`: assert `discoveryPolicy('dad').digest === 'be91648ac06f7508faf9148c339d25e0a704f4b7c61c7918b8e7b23892113954'`, `JSON.stringify(discoveryPolicy('dad').definition) === '<pinned 869-char body>'` (paste the literal from design §8.6(a), captured from baseline — confirmed equal in this worktree), and keep the existing relative `=== discoveryPolicy().digest` check.
      **(b) Compose-argv snapshot** in a new/extended test driving `DadAdapter` with a stubbed `command` (the lowest point both `logged→command` and `compose→command` pass through). Assert the emitted argv equals the pinned pre-refactor literal for EACH composeRun-rewritten site AND `suite` (fold-in #1): `database-start`, `migrations`, `test-migrations` (acceptance mode), `suite('api-tests')`, `suite('web-tests')`, `deploy`, `cleanup`'s `down`; PLUS the `sql`/exec path — drive `sql('SELECT 1')` and assert argv === `['compose','-p',<id>,'-f',<file>,'exec','-T','postgres','psql','-X','-v','ON_ERROR_STOP=1','-U','atm_owner','-d','dad_atm','-At']`. Pinned `suite` literals: `['compose','-p',<id>,'-f',<file>,'run','--rm','-T','api-tests']` and `[... 'web-tests']`. `deploy`'s readiness health-exec and the replay stop/start/pg_dump are NOT separately guarded — covered transitively by the `sql`/exec guard (fold-in #2).
      **(c) Interface-surface conformance test** for both `resolveTarget('dad').adapterFactory(...)` and `BenchmarkAdapter`: required methods `snapshot/docker/build/database/deploy/discoveryFixture/cleanup` present, `publicOrigin`/`signal` assignable, `discoveryReplayFixture`/`source` absent-or-right-kind.
      Files: `test/targets.test.js`, `test/adapter.test.js` (or a new `test/dad-argv.test.js`), and a conformance test file.
      Verify: `npm run lint && npm test` fully green. Guards fail loudly on any digest/JSON/argv drift.

- [ ] 7. Benchmark smoke check: confirm the in-process wiring still works end-to-end without Docker/model. Run the relocated benchmark adapter test and the benchmark path.
      Files: none (verification only).
      Verify: `npm test` green (includes `benchmark-adapter.test.js` through the shim). Optionally `node src/cli.js explore --target benchmark` wires the in-process adapter (no Docker/model) — relocated benchmark adapter test passing is the required signal.

- [ ] 8. Docs touch-up (optional, non-behavioral): note the `src/targets/` layout and the formal interface in `README.md` if a natural spot exists. Do NOT alter DAD identifier guidance.
      Files: `README.md` (optional)
      Verify: `npm run lint` clean.

## Final integration gate (run after all units)

- `npm run lint` clean; `npm test` → all green (≥ 109 + new tests).
- `git -C … diff dev -- src/runner.js` → empty.
- Policy digest/JSON and all argv guards pass (byte-identical proof).
- Infra-gated suites remain resolvable (not run here).

## Assumptions / noted gaps

- Full DAD Docker provisioning is not exercised here; the byte-identical proof is argv-snapshot + unit suite + policy snapshot, as the task directs.
- `freePort` form resolved to a base method (fold-in #3); SQL builders become independently unit-testable, a net gain, but that is optional beyond the required argv guard.
