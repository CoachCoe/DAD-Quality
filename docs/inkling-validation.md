# Inkling validation — 2026-10-15

ATM's Tinker connection check succeeded with `thinkingmachines/Inkling`.
The API integration is working; autonomous investigation quality is not yet established.

## Live observations

Two ImpactGraph explorations used committed revision
`5c039af8b3ec3bae869ecf334cbb896283f2f940` with disposable synthetic fixtures.

- Initial run `atm-20261015193838-a4011fce`: 22 requests and 102,131 accounted
  tokens. Fixture setup restarted the application while nginx retained a stale
  upstream address, producing 502s. Rejected contracts repeated until the token cap.
- After restarting ingress with the fixture, run
  `atm-20261015194616-4420faca`: the actual home page loaded with no captured
  server errors. One plan was accepted, but the model repeatedly tried to replace
  it. The new rejection guard stopped after five requests and 26,580 accounted
  tokens. The result was inconclusive, with no verified defect.
- A first benchmark attempt encountered a provider HTTP 502 and then a report
  finalization crash. Report finalization now handles manifests without a
  versioned acceptance policy. CLI regression tests retain all five cases both
  for provider errors and partial work, without live model calls.

## Seeded-defect benchmark

One complete pass used the same model, 24 requests maximum per case, 2,000 output
tokens per request, a 100,000 accounted-token cap and ten minutes per case.
The prompt clarified that an accepted contract must be executed before replanning.

| Variant | Result | Independently verified findings | Requests |
| --- | --- | ---: | ---: |
| Healthy | Invalid model action; inconclusive | 0 | 1 |
| Lost save | Three rejected plans; inconclusive | 0 | 3 |
| Cross-actor write | Invalid model action; inconclusive | 0 | 1 |
| Accept invalid name | Invalid model action; inconclusive | 0 | 1 |
| Duplicate write | Three rejected plans; inconclusive | 0 | 3 |

Detection was **0/4**, with **0/5** cases completed. No healthy-app findings were
reported, but that single incomplete healthy case does not establish a low false
positive rate. This measures the current model/prompt/harness combination under
these limits, not all Tinker models or Inkling's general capability.

The local aggregate is
`.atm/benchmarks/benchmark-1792099878547/benchmark.json`. It recorded nine requests
and 17,518 accounted tokens, **excluding usage on rejected model actions** because
that accounting bug was found during review. Actual usage is higher and cannot
be reconstructed from the retained reports. The adapter now retains valid Tinker
usage on rejection/truncation errors; the discovery loop counts it, and explicitly
marks unknown usage. Old reports are retained unchanged. No currency estimate is
provided because no model price was supplied.

## Next experiment

Keep current strict action validation and independent fixture checks. Add compact
schema-error feedback and explicit execution-state guidance, then compare a
versioned prompt on these same five blinded variants. Improve plan execution
before expanding roles, applications or runtime budgets. Retain incomplete runs
in the denominator and distinguish observed mismatches from verified detections.

Local secrets, source archives, browser traces and raw reports remain in ignored
`.atm/` storage. This summary contains no keys or session values.
