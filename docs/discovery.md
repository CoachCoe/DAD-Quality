# Autonomous application discovery

ATM's `explore` mode starts with a running application and synthetic identities,
not a prescribed journey, goal library, or sequence of assertions. The model
discovers visible capabilities, chooses hypotheses to investigate, performs UI
experiments, and reports supported mismatches. Existing validation remains a
separate mode. Exploration does not run unit, E2E, or load suites.

## Start an exploration

Set `OPENAI_API_KEY` and `ATM_MODEL` in your shell, or create the private, ignored
file `.atm/agent.env`:

```dotenv
OPENAI_API_KEY=your-key
ATM_MODEL=your-tool-capable-model
```

```sh
npm run explore -- --repo /Users/shawncoe/Documents/dev/ImpactGraph --revision origin/dev
```

`npm run explore` explicitly loads that file with Node's environment-file parser;
it does not execute shell content. Shell variables take precedence. Alternatively,
`npm run atm -- explore --repo PATH --model MODEL` uses shell credentials only.
An explicit model supporting strict Responses API function calls is required.
Missing configuration fails before provisioning. Never commit the key.

To use **Explore application** in the dashboard with that file:

```sh
node --env-file=.atm/agent.env src/serve.js --repo /Users/shawncoe/Documents/dev/ImpactGraph
```

Working-tree edits are excluded. ATM archives the exact committed candidate,
builds production images, creates a disposable database, and removes runtime
containers after exploration or cancellation. Credentials stay outside application
processes and the browser. The default history is `.atm/runs` for both modes.

## Discovery and investigation

The adapter provides a guest and two independently identified, already claimed
synthetic donors. Each donor has one distinguishable synthetic gift. These are
fixtures, not goals. The agent receives identity descriptions, entry pages,
visible text, observed controls, discovered links, and server/JavaScript errors.
It does not receive cookies, API keys, arbitrary filesystem access, SQL, or an
application-specific success script.

The agent can:

- Record its own investigation title and hypothesis, linked to an observation.
- Navigate discovered pages, click observed controls, fill fields, select options,
  toggle controls, reload, and switch identity.
- Report a current mismatch against an explicit text or error expectation.
- End the run with a summary of coverage and uncertainty.

Only the model decides which capabilities to investigate and which experiments
to perform. The browser broker maps observation IDs to captured controls; the
model cannot supply selectors, JavaScript, arbitrary URLs, or HTTP requests.
Out-of-origin requests, redirect hops, WebSockets, service workers, downloads,
and popup interaction are restricted by the existing browser layer. Password and
file inputs are not exposed as agent controls. Same-origin UI mutations are
permitted against disposable data. Payment, mail, push, and workers are disabled.
Failures caused by these missing services must be treated as environment limits.

App text and previous discoveries are treated as untrusted data in the prompt.
Tool and network restrictions are enforced outside the model. This is for trusted
application source: build scripts still execute code from the selected repository.

## Evidence and reproduction

`discovery.json` retains the application map, hypotheses, observations, every
decision and outcome, prior memory references, usage, and potential findings.
Screenshots accompany observations. Switching actors creates a fresh browser
context, including IndexedDB and Cache Storage; each context retains a separate
trace (`discovery-trace.zip`, then numbered segments). Saved page maps remain
snapshots of what was known at that point. Reports and referenced files have
content hashes and remain private locally.
The dashboard exposes the report, decision trail, map, and findings.

The harness evaluates each reported expectation against captured visible text or
browser errors. An assertion contradicted by the evidence is rejected. Truncated
text makes text checks inconclusive. Supported expectations are `text_present`,
`text_absent`, `no_server_error`, and `no_page_error`.

A read-only investigation is replayed from its actor's entry in a fresh browser
context, with the same initial synthetic session. Recorded controls must still
match their labels, names and destinations, not just their DOM position.
Navigation must reach the captured observation's page, and error reports must
reproduce an error from that observation. Automatic replay stops after any application mutation, after 30
actions, on forbidden requests, or on divergent controls/state. It never repeats
a mutation to manufacture evidence. These reports remain **observed**; a matching
independent replay becomes **reproduced**. Replay steps, actor, candidate SHA,
screenshots, and both observations make the result reviewable.

Neither label means the expected behavior is correct. A model can misunderstand
the product. All findings are hypotheses until a human reviews the stated basis.
The Findings view supports confirmation, dismissal, severity, and resolution.
Unreviewed discovery hypotheses do not block unrelated validation runs. Confirmed
findings use the existing severity policy. A later exploration ending successfully
does not resolve a prior finding.

## Memory and limits

Before each run, ATM reads up to five completed, hash-verified discovery reports
from the same source repository and history directory. It carries a bounded
summary of known pages, investigations, findings, and unfinished work. The agent
is told that memory is stale evidence to revisit, not current truth. Invalid
reports, including those with altered supporting screenshots or traces, are
excluded with a visible warning. Memory is reconstructed from retained
evidence, so concurrent runs do not overwrite a shared memory file. Local and
GitHub histories are not synchronized automatically.

Each run permits at most 40 model requests, 10 minutes of exploration, 2,000 output
tokens per request, and 100,000 accounted tokens. The last response can exceed the
token threshold; its action is not executed. Reaching the threshold exactly stops
further requests. Request counts include failed attempts. These are resource bounds, not a
currency budget. Each request has at most 60,000 input characters. Provider errors,
missing usage accounting, cancellation, and exhausted budgets retain partial
evidence and cannot appear as complete exploration. A completed run means the
agent ended its bounded investigation, never that the application is bug-free.

CLI exit 0 means exploration and cleanup completed; 2 means partial/inconclusive,
1 an infrastructure check failure, and 130 user cancellation. There is no release
authorization from exploration. Existing required-check branch protection remains
deferred. Discovery is manually launched; commit watch and GitHub continue using
their existing validation mode and do not incur model usage automatically.

The first adapter covers public and donor UI discovery. Staff provisioning,
arbitrary API investigation, database-backed assertions, automatic clean-fixture
replay of mutations, semantic deduplication, and scheduled unattended exploration
remain future extensions. No product-spec oracle is claimed.

## Verification

Harness tests use a controlled model provider and real Chromium against small
fault-injection applications. They check observed-control navigation, actor
isolation, server-error reproduction, write-replay refusal, unsupported claims,
budgets, cleanup, memory integrity, and dashboard presentation. They test the
agent infrastructure; they do not demonstrate a live model's discovery ability.
A live-model run against ImpactGraph requires configured credentials and should
be reviewed separately for useful investigations and false-positive rate.

The provider uses the official [Responses function-calling interface](https://developers.openai.com/api/docs/guides/function-calling)
with a strict tool schema, one action per request, and `store: false`. Each request
is self-contained with bounded observations and decision summaries.
