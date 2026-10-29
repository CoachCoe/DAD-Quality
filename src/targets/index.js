import { BenchmarkAdapter } from './benchmark.js';
import { DadAdapter } from './dad/index.js';
import { GenericWebAdapter } from './generic/index.js';

// DAD keeps its original impactgraph identifiers so existing ledgers, policies
// and finding IDs remain valid.
export const targets = {
  dad: {
    adapterFactory: (run, options) => new DadAdapter(run, options),
    policyId: 'impactgraph-discovery',
    adapterId: 'impactgraph',
  },
  'generic-web': {
    adapterFactory: (run, options) => new GenericWebAdapter(run, options),
    policyId: 'generic-web-discovery',
    adapterId: 'generic-web',
  },
  benchmark: {
    adapterFactory: (run, options) => new BenchmarkAdapter(run, options),
    policyId: 'benchmark-discovery',
    adapterId: 'benchmark',
  },
};

export function resolveTarget(name = 'dad') {
  const target = targets[name];
  if (!target) throw new Error(`Unknown target: ${name}. Known targets: ${Object.keys(targets).join(', ')}.`);
  return target;
}

export const isRegisteredAdapter = id => Object.values(targets).some(t => t.adapterId === id);
