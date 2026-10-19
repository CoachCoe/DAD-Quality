// Definitions describe versioned, implemented handlers, not executable user input.
export const scenarios = {
  'staff-journey': {
    id: 'staff-journey',
    version: 1,
    goal: 'Activate a staff passkey, sign out and sign back in.',
    preconditions: [
      'Migrated disposable database',
      'Run-scoped administrator invitation',
      'Deployed public and staff origins',
    ],
    constraints: ['Synthetic accounts only', 'Only run-owned origins', 'No external integrations'],
    successCriteria: [
      'Visible authenticated administrator',
      'Persisted passkey and active/revoked sessions',
      'Invitation replay rejected',
      'Host and anonymous access boundaries enforced',
    ],
    failureCriteria: [
      'Unexpected authentication or routing response',
      'Persisted invariants fail',
      'Unexpected outbound requests or browser errors',
    ],
  },
  'donor-claim-journey': {
    id: 'donor-claim-journey',
    version: 1,
    goal: 'Claim a synthetic donor account, retain access after reload, then sign out and reject link replay.',
    preconditions: [
      'Migrated disposable database',
      'Seeded unclaimed donor and two one-time login links',
      'Deployed public origin',
    ],
    constraints: [
      'Fixture setup only in run-owned database',
      'Only run-owned public origin',
      'No email delivery or payment submission',
      'Verification queries are read-only',
    ],
    successCriteria: [
      'Claim UI confirms sign-in',
      'Authenticated dashboard survives reload',
      'Database records claim, both consumed links and exactly one session',
      'Sign-out revokes session',
      'Replayed and sibling links are rejected without issuing another session',
      'Anonymous dashboard returns 401',
    ],
    failureCriteria: [
      'Unexpected claim or dashboard response',
      'Missing or extra persisted session',
      'Link replay grants access',
      'Unexpected outbound requests or browser errors',
    ],
  },
  'ai-public-journey': {
    id: 'ai-public-journey',
    version: 1,
    goal: 'Find the public donation form without submitting it.',
    preconditions: ['Deployed public origin', 'Explicit model and provider credentials'],
    constraints: ['Read-only same-origin requests', 'At most 12 actions and 180 seconds', 'No form submissions'],
    successCriteria: [
      'Independent DOM verifier confirms donation path, email field and monthly option',
      'No forbidden requests',
    ],
    failureCriteria: [
      'Verifier rejects completion claim',
      'Invalid action, provider error or exhausted budget is inconclusive',
    ],
  },
};
