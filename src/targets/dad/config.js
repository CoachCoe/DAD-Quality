export const requiredFiles = ['apps/donor-api/Dockerfile', 'apps/web/Dockerfile', 'apps/web/package-lock.json'];

export const buildServices = [
  ['api', 'apps/donor-api/Dockerfile'],
  ['web', 'apps/web/Dockerfile'],
];

export const cleanupLogServices = ['api', 'web', 'ingress'];

export const database = 'dad_atm';
export const owner = 'atm_owner';
