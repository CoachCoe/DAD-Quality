import { BenchmarkAdapter } from './benchmark-adapter.js';
import { DadAdapter } from './dad.js';

// Registry of discovery targets. Each entry maps a target name to the adapter
// factory that provisions it and the policy/adapter identity it emits. DAD's
// identifiers ('impactgraph-discovery', 'impactgraph') are retained verbatim so
// ledger and finding compatibility is preserved.
export const targets = {
  dad: {
    adapterFactory: (run, options) => new DadAdapter(run, options),
    policyId: 'impactgraph-discovery',
    adapterId: 'impactgraph',
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
