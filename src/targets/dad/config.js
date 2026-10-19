// DAD-specific configuration data (no behavior). Values are byte-identical to
// the literals previously inlined in src/dad.js. These intentional
// compatibility aliases (impactgraph identifiers, the dad_donor_session cookie,
// db/role names) must never be renamed.

// Tracked files that must exist in the archived revision.
export const requiredFiles = ['apps/donor-api/Dockerfile', 'apps/web/Dockerfile', 'apps/web/package-lock.json'];

// Image build inputs: [service, dockerfile] pairs built from the source tree.
export const buildServices = [
  ['api', 'apps/donor-api/Dockerfile'],
  ['web', 'apps/web/Dockerfile'],
];

// Services whose tail logs are collected best-effort during cleanup.
export const cleanupLogServices = ['api', 'web', 'ingress'];

// Database and role identifiers.
export const database = 'dad_atm';
export const integrationDatabase = 'donor_go';
export const owner = 'atm_owner';
export const apiRole = { user: 'atm_api', grant: 'dad_api' };
export const staffRole = { user: 'atm_staff', grant: 'dad_staff_cli' };

// Session cookie name used for discovery/performance donor actors.
export const cookieName = 'dad_donor_session';
