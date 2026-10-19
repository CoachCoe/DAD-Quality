# Move 3 adapter split — implementation fidelity review

Splits the DAD-coupled `DadAdapter` monolith into a reusable `ProvisioningAdapter` base (`src/targets/base.js`), a DAD package (`src/targets/dad/{index,config,compose,sql}.js`), a relocated benchmark adapter and registry under `src/targets/`, and three thin re-export shims at the old module paths. The approved design is taken as given; this review checks whether the implementation keeps the DAD target byte-identical and lands all five mandatory fold-ins. I re-derived every byte-identity invariant directly from the worktree against `dev` rather than trusting the fixer's evidence alone — digest, policy-JSON length, `composeDefinition` body, every rewritten argv, all SQL builder strings, the shims, the registry, `runner.js`, and the eight engine files all matched independently.

Watch for: nothing blocking. One informational note — DAD's `snapshot` was extracted into the base class rather than kept inline (confirmed, the archive/hash/candidate bytes are unchanged and only `requiredFiles`/message/`source` are parameterized). The base class also ships unused convenience wrappers (`buildImages`, `up`, `down`, `cleanupFlow`) that DAD deliberately does not call; this is intentional per the design (DAD inlines `composeRun` to keep argv guards exact) and carries no DAD behavioral risk.

**Verdict**: APPROVED

## High-level view

Byte-identity holds end to end. `discoveryPolicy('dad').digest` is `be91648…113954` and the definition JSON is 869 chars (both re-run live, not just read from evidence); the DAD cookie `dad_donor_session` is intact; `git diff dev -- src/runner.js` is empty; and the `impactgraph`/`impactgraph-discovery` identifiers are untouched (every remaining `impactgraph` hit is an intentional alias in the registry, runner, policy path, history fallback, or CLI help).

The composeRun and execSql rewrites are faithful. Each rewritten call site's flattened argv equals its pre-refactor inlined array element-for-element — I diffed `database-start` (incl. the `test-postgres` spread), `migrations`, `test-migrations` (incl. the templated `DONOR_GO_DATABASE_URL`), `suite`, `deploy`, `cleanup`'s `down`, and the `sql`→`execSql` psql invocation (with the load-bearing `-X -v ON_ERROR_STOP=1`) against `dev` and all match.

All five fold-ins are present. Fold-in #1 is the most load-bearing and is fully satisfied: `test/dad-argv.test.js` carries argv guards for **both** `suite('api-tests')` and `suite('web-tests')`, and every composeRun/execSql-rewritten site has a matching guard.

The eight discovery-engine files are unchanged versus `dev`, the `src/targets/` layout plus three re-export shims keep every existing deep import resolving without edits, and no test coverage was deleted (only additions plus an extended `targets.test.js`).

<details>
<summary>Issues (0 blocking, 2 informational)</summary>

1. **Snapshot extracted, not inlined (informational)** — DAD's `snapshot` delegates to the base `snapshot(result, { requiredFiles, requireMessage, source })`. Verified behavior-identical; no action needed. Flagged only because it is the one DAD provisioning method whose body moved into the base rather than staying in the subclass.
2. **Unused base convenience wrappers (informational)** — `buildImages`, `up`, `down`, `cleanupFlow` on `ProvisioningAdapter` are not called by DAD (it inlines `composeRun` to keep the argv guards exact). Dead-for-now but intentional per the design; no action needed.

</details>

<details>
<summary>Details</summary>

## Byte-identical DAD policy, cookie, identifiers

`node -e "…discoveryPolicy('dad')…"` prints `be91648ac06f7508faf9148c339d25e0a704f4b7c61c7918b8e7b23892113954 869` — the pinned digest and the 869-char definition, re-derived live in the worktree (confirmed). `test/targets.test.js` locks both with frozen literals (`EXPECTED_DAD_POLICY_DIGEST` and the pasted 869-char `EXPECTED_DAD_POLICY_JSON`) plus the relative `=== discoveryPolicy().digest` check, so any future drift fails loudly.

The cookie `dad_donor_session` survives in `discovery-browser.js` (the `who.cookieName ?? 'dad_donor_session'` default), `targets/dad/config.js`, `targets/dad/sql.js` (actor descriptor + performance cookie strings), and `performance.js` — unchanged (confirmed). Every `impactgraph` reference is an intentional alias: registry `policyId: 'impactgraph-discovery'`/`adapterId: 'impactgraph'`, `runner.js` adapter `'impactgraph'`, `policies/impactgraph-local.json`, the `history.js` source fallback, and CLI help text. No identifier was renamed (confirmed).

## composeRun / execSql rewrite fidelity

The base helper prepends exactly `['compose','-p',this.id,'-f',this.file]` then appends `args` verbatim, and `execSql` binds only `service`/`user`/`db` into `['exec','-T',service,'psql','-X','-v','ON_ERROR_STOP=1','-U',user,'-d',db,'-At']`. Comparing each rewritten DAD call site against the `dev` inlined array:

```
database-start  up -d --wait --wait-timeout 90 postgres [test-postgres]   ✓ (spread preserved)
migrations      run --rm -T migrate            {failureStatus:'failed'}   ✓
test-migrations run --rm -T -e DONOR_GO_DATABASE_URL=…@test-postgres/… migrate  ✓
suite           run --rm -T <name>             {timeout:900_000,failureStatus:'failed'}  ✓
deploy          up -d --wait --wait-timeout 120 api web ingress  {timeout:180_000}  ✓
cleanup down    down --volumes --remove-orphans --timeout 10  {timeout:90_000}  ✓
sql/execSql     exec -T postgres psql -X -v ON_ERROR_STOP=1 -U atm_owner -d dad_atm -At  {input:query}  ✓
```

`owner`/`database` in `config.js` resolve to `atm_owner`/`dad_atm`, so `execSql` reproduces the exact psql argv. The `-X -v ON_ERROR_STOP=1` flags are preserved in order. `deploy`'s readiness health-exec and `discoveryReplayFixture`'s stop/start/pg_dump remain plain `this.compose(...)` (pure relocation, fold-in #2) and are covered transitively by the `sql`/exec guard. The `roleSetupSql` string and the `verifyStaff`/`verifyDonor`/`discoveryState`/`donorFixture`/`discoveryFixture`/`performanceFixture`/`replayRestore` SQL builders return strings byte-identical to the `dev` inlined literals (compared programmatically; all matched).

## The five fold-ins

Fold-in #1 (suite argv guards + a guard per rewritten site): `test/dad-argv.test.js` drives `DadAdapter` with stubbed `logged`/`compose` and asserts pinned argv for `database-start` (acceptance and exploration), `migrations`, `test-migrations`, `suite('api-tests')` **and** `suite('web-tests')`, `deploy`, `cleanup` down, and `sql('SELECT 1')`. Both suite literals are present and distinct (`…run --rm -T api-tests` / `…web-tests`). Fold-in #2 (deploy health-exec + replay stay plain `compose`, no extra guard): honored in `dad/index.js`. Fold-in #3 (`this.freePort()` base method): `docker()` calls `await this.freePort()` and the base defines it. Fold-in #4 (`*-checks` build citation 266–272): the `build-${service}-checks` block is present and mode-gated, matching `dev`. Fold-in #5 (runner-produced discovery/journey evidence noted in the interface doc): present in the `base.js` JSDoc.

## `composeDefinition` and compose topology

The `composeDefinition(...)` function body in `targets/dad/compose.js` is byte-identical to the `dev` `dad.js` body (brace-matched extraction compared equal), and the nginx `proxy_pass http://web:3000` template region matches. Service names, env var names, pinned images, db/role identifiers live in `config.js` as data with values unchanged.

## Engine, runner, and layout

The eight engine files — `discovery.js`, `discovery-browser.js`, `experiments.js`, `experiment-contract.js`, `application-memory.js`, `source-reader.js`, `core.js`, `model-provider.js` — each produce an empty `git diff dev` (confirmed, 0 lines each). `src/runner.js` is byte-identical to `dev` (empty diff), kept on the `./dad.js` shim. The three shims are the exact one/two-line re-exports the design specifies, the registry `targets/index.js` is value-identical to `dev`'s `targets.js` (only the two import paths changed to `./dad/index.js` and `./benchmark.js`), no file under `src/targets/` imports a shim (grep returns none, so the import graph stays an acyclic DAG), and `BenchmarkAdapter` does not extend the base.

## Test coverage

Added: `test/base.test.js` (base helper units), `test/dad-argv.test.js` (8 argv guards), `test/interface-conformance.test.js` (dad + benchmark surface). Modified: `test/targets.test.js` (digest + 869-char JSON snapshot + registry identity). No test file deleted — coverage was not removed. Per the recorded evidence, lint is clean (84 files, 0 warnings) and `npm test` is 123 pass / 0 fail with unchanged deep imports resolving through the shims.

Not tested here (stated, not faked): full DAD Docker provisioning and the Playwright `*.browser.js` suites are not runnable without Docker/Chromium/model keys. Byte-identity for the rewritten provisioning call sites is proven instead by the argv-snapshot guards, the pinned digest/JSON snapshot, the unchanged engine suite, and the empty `runner.js` diff — the correct strategy given the environment.

</details>

<details>
<summary>File map</summary>

- `src/targets/base.js` — new `ProvisioningAdapter` base + formal-interface JSDoc.
- `src/targets/dad/index.js` — `DadAdapter extends ProvisioningAdapter`; composeRun/execSql/freePort rewrites applied.
- `src/targets/dad/compose.js` — `composeDefinition` + nginx template (byte-identical move).
- `src/targets/dad/sql.js` — DAD SQL builders (byte-identical strings).
- `src/targets/dad/config.js` — DAD data (files, images, services, db/roles, cookie).
- `src/targets/benchmark.js` — benchmark adapter relocated verbatim (no base).
- `src/targets/index.js` — registry relocated (value-identical).
- `src/dad.js`, `src/targets.js`, `src/benchmark-adapter.js` — thin re-export shims.
- `src/cli.js`, `src/discovery-runner.js`, `src/policy.js` — registry import path repointed.
- `src/runner.js` — UNCHANGED (empty diff).
- `test/base.test.js`, `test/dad-argv.test.js`, `test/interface-conformance.test.js` — new; `test/targets.test.js` — extended.
- `.agents/tasks/features/FEAT-001.json`, `FEAT-002.json`, `move3-verification.md` — docs.

Full diff: `git -C /Users/shawncoe/Documents/dev/DAD/atm/.worktrees/move3-adapter-split diff dev`.

</details>
