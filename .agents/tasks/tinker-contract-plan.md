# Implementation Plan — Tinker provider strict tool-call contract

Goal: Make the ATM Tinker model provider satisfy the strict discovery action schema the
same way the OpenAI provider does, so non-OpenAI backends work. OpenAI's structured output
(`strict: true` + `required: [all]`) always returns every field; the Tinker Anthropic-compatible
Messages API does not force the model to populate every required field, so a model that returns
only the meaningful fields (e.g. `{ "reason": "..." }`) fails the exact-key-set / all-strings
check in `validateDiscoveryAction` and throws "Tinker returned an invalid action."

## Diagnosis confirmed against code

- `validateDiscoveryAction` (src/discovery.js) requires an EXACT key-set match of the seven keys
  (`action, target, value, title, reason, expectation, text`) via
  `Object.keys(value).sort().join() !== [...keys].sort().join()`, then all values must be strings
  (`keys.some(k => typeof value[k] !== 'string')`), then `actions.includes(value.action)`, then the
  per-field length/semantic rules.
- `tinkerToolProvider` (src/model-provider.js, ~lines 28–100) sends `tool.parameters` as
  `input_schema`, passes the `stop_reason === 'tool_use'` / `calls.length === 1` /
  `calls[0].name === tool.name` check (~line 77), then calls `validate(calls[0].input)` inside a
  try/catch that rethrows as `failure('Tinker returned an invalid action.')` (~lines 79–83). The
  under-populated input fails `validate` at the key-set/string-type stage.
- `tinkerToolProvider` already receives the full `tool` definition, so `tool.parameters.properties`
  (map of `{ name: { type, enum? } }`) and `tool.parameters.required` (array) are both available.
  The provider must stay generic — it must NOT hardcode the seven discovery field names.
- The provider is SHARED: `discoveryProvider` (7-field `investigate_application` tool) and
  `publicProvider` in src/agent.js (3-field `browser_action` tool, properties `action`/`role`/`name`,
  all string-typed). A schema-driven backfill serves both correctly.
- CORRECTNESS BOUNDARY holds: backfilling a missing discriminator to `''` still fails validation
  because `''` is not in the `action` enum (`actions.includes('')` is false), and for `browser_action`
  `''` is not in its `action`/`role` enums. Backfill only rescues the case where the meaningful fields
  are present but other required-but-empty string fields were omitted.
- `RunError` (src/core.js) defaults to `status: 'inconclusive'`; the failure wrapper copies `tokens`
  when accounting is valid. Existing tests assert `e.status === 'inconclusive'` and `e.tokens === 26`,
  so the backfill must stay INSIDE the existing `validate` try/catch to preserve that behavior.

## Design decisions

- Backfill location: immediately BEFORE `validate(calls[0].input)`, inside the existing try block,
  so a backfilled-but-still-invalid action (missing discriminator) throws through the same
  `failure('Tinker returned an invalid action.')` path and keeps token accounting on the error.
  Rationale: preserves the existing error contract the tests already lock in.
- Backfill rule (generic, schema-driven): for each property in `tool.parameters.properties` whose
  declared `type === 'string'`, if the key is absent from the returned input (`!Object.hasOwn(input, key)`),
  set it to `''`. Do not touch existing values, do not coerce non-string values, do not add non-string
  properties, do not strip extra keys the model returned (the validator rejects those as today).
  Rationale: matches the OpenAI `required: [all]` effect (empty strings where not applicable) without
  the provider knowing any specific contract. Reading `required` is unnecessary and could wrongly add
  keys the schema does not declare as properties; drive purely from `properties` + string type.
- Implement as a small local pure helper (e.g. `backfillStringFields(schema, input)`) returning a new
  object, keeping `tinkerToolProvider` readable and the OpenAI path untouched.

- [ ] 1. Add schema-driven backfill of missing string fields in `tinkerToolProvider`.
      Add a small pure helper that, given `tool.parameters` and the returned `calls[0].input`, returns a
      shallow copy with every property that `properties` declares as `{ type: 'string' }` and that is
      missing from the input (`!Object.hasOwn`) defaulted to `''`; existing values and any extra keys are
      left untouched and non-string properties are never added. Call it to produce the object passed to
      `validate(...)`, keeping the call inside the existing try/catch so a still-invalid result (e.g.
      missing `action` discriminator) throws the same `failure('Tinker returned an invalid action.')` with
      `status: 'inconclusive'` and `tokens` preserved. Guard for a non-object/array input and for missing
      `tool.parameters.properties` by falling back to the original input (let the validator reject it).
      Do NOT change `validateDiscoveryAction`, the stop_reason/single-call/name check, token accounting,
      `responseId`/`usage` handling, or anything in the OpenAI path (src/discovery.js OpenAI branch,
      src/agent.js `openAIProvider`).
      Files: src/model-provider.js
      Verify: `cd /Users/shawncoe/Documents/dev/DAD/atm/.worktrees/tinker-contract-fix && npm run lint` — Biome passes with no warnings/errors.

- [ ] 2. Add focused unit tests proving the end-to-end contract via the real discovery tool + real validator.
      Add tests to test/model-provider.test.js (append; reuse the existing `action`, `input`, `body()`,
      and `provider()` helpers and the fake `fetchImpl` stub pattern — no network, no real key). Cover three
      cases, each via `provider(reply)(input)` so the real `discoveryProvider` + real
      `validateDiscoveryAction` run:
      (1) Backfill success: build a `body()` whose `content[1].input` is a well-formed action with a valid
          `action` plus the fields that action needs, but with several schema-declared string fields removed
          (e.g. delete `title`, `expectation`, `text`); after the fix, `await provider(reply)(input)` resolves
          and `result.action` has ALL seven keys present, with `''` for the backfilled ones and the supplied
          values unchanged (assert with `assert.deepEqual` against the fully-populated expected action).
      (2) Missing discriminator NOT masked: `content[1].input = { reason: 'because' }` (no `action`); assert
          `provider(reply)(input)` rejects with the "Tinker returned an invalid action." message and
          `e.status === 'inconclusive'` (and `e.tokens === 26`, since `body()` usage totals 26), proving the
          discriminator gap is not rescued.
      (3) Regression: a fully-populated `body()` response is returned unchanged — reuse the existing
          `action`/`body()` and assert `assert.deepEqual(result.action, action)` (this is already covered by the
          "Tinker sends bounded Messages tool requests..." test, so add an explicit assertion only if it adds
          value; otherwise note it is covered and keep the new tests to cases 1 and 2).
      Files: test/model-provider.test.js
      Verify: `cd /Users/shawncoe/Documents/dev/DAD/atm/.worktrees/tinker-contract-fix && npm test` — `node --test test/*.test.js` runs; all tests pass including the new cases and the pre-existing Tinker tests (duplicate/foreign/malformed rejection, token accounting, key-safety, public-journey).

- [ ] 3. Final verification of the whole change set.
      Run lint and the full unit suite together to confirm the worktree is green and nothing else regressed.
      Do NOT attempt a live Tinker/OpenAI API call (no keys/network); the live `model:check` re-check is the
      orchestrator's job post-merge.
      Files: (none — verification only)
      Verify: `cd /Users/shawncoe/Documents/dev/DAD/atm/.worktrees/tinker-contract-fix && npm run lint && npm test` — both succeed with zero failures.

## Notes / assumptions

- Node >=22 (v24 on box), ESM. Commands must run with cwd
  `/Users/shawncoe/Documents/dev/DAD/atm/.worktrees/tinker-contract-fix`; step agents' cwd is the parent
  workspace, so always `cd` into the worktree (or use absolute paths and
  `git -C /Users/shawncoe/Documents/dev/DAD/atm/.worktrees/tinker-contract-fix`).
- `body()` usage is `{ input_tokens: 17, output_tokens: 9 }` = 26 total, which is why case (2) asserts
  `e.tokens === 26`.
- No AGENTS.md/CONTRIBUTING.md/.kiro steering in the worktree; README.md is the only doc. Build/test
  commands are taken from package.json (`lint`, `test`) and biome.json.
