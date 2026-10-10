import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { evaluate, verifyEvidence } from './core.js';
import { policyIssues, hashPolicy } from './policy.js';
import { listRuns, collectFindings } from './history.js';

// Pure decision: identical candidate, policy, evidence and finding inputs yield
// an identical assessment. It deliberately does not read a clock or trust a saved verdict.
export function evaluateRelease(run, { evidenceIssues = [], findings = [], inputIssues = [] } = {}) {
  const reasons = [...policyIssues(run), ...inputIssues, ...evidenceIssues];
  const outcome = evaluate(run.required, run.results);
  if (!run.finishedAt) reasons.push('Run is incomplete.');
  if (run.canceledAt) reasons.push('Run was canceled.');
  if (!/^[a-f0-9]{40,64}$/.test(run.candidate?.revision ?? '') || !run.candidate?.source || !/^[a-f0-9]{64}$/.test(run.candidate?.sourceArchiveSha256 ?? '')) reasons.push('Pinned source identity is missing.');
  if (!['api', 'web'].every(name => /^sha256:[a-f0-9]{64}$/.test(run.candidate?.images?.[name] ?? ''))) reasons.push('Built application image identities are missing.');
  if (!outcome.eligible) reasons.push(...outcome.reasons);
  const definition = run.policy?.definition;
  if (!policyIssues(run).length) {
    for (const check of definition.checks.filter(c => c.required)) {
      const result = run.results.find(r => r.id === check.id);
      if (!result?.finishedAt) reasons.push(`${check.id}: no completion record.`);
      for (const name of check.evidence) {
        if (result?.evidence?.filter(e => e.path === `evidence/${name}`).length !== 1) reasons.push(`${check.id}: required evidence missing or duplicated: ${name}`);
      }
    }
  }
  const relevant = findings.filter(f => f.source === run.candidate?.source).map(f => ({ id: f.id, severity: f.severity, disposition: f.disposition, updatedAt: f.updatedAt ?? null, lastSeen: f.lastSeen })).sort((a, b) => a.id.localeCompare(b.id));
  for (const finding of relevant) {
    if (!['resolved', 'dismissed'].includes(finding.disposition) && (definition?.findings?.blockingSeverities ?? ['unassessed', 'high', 'critical']).includes(finding.severity)) reasons.push(`Unresolved ${finding.severity} finding: ${finding.id}`);
  }
  const unique = [...new Set(reasons)].sort();
  return { status: unique.length ? 'blocked' : 'eligible', eligible: unique.length === 0, scope: 'local-acceptance', productionAuthorized: false, policyDigest: run.policy?.digest ?? null, findingsDigest: hashPolicy(relevant), findings: relevant, reasons: unique };
}

export async function assessRelease(root, run) {
  const { runs, warnings } = await listRuns(root);
  let triage = {};
  const inputIssues = [...warnings];
  try {
    const saved = JSON.parse(await readFile(path.join(root, '.dashboard/state.json'), 'utf8'));
    if (!saved.triage || typeof saved.triage !== 'object' || Array.isArray(saved.triage)) throw new Error('Invalid finding state');
    for (const value of Object.values(saved.triage)) {
      if (!['untriaged', 'confirmed', 'resolved', 'dismissed'].includes(value.disposition) || !['unassessed', 'low', 'medium', 'high', 'critical'].includes(value.severity) || (['resolved', 'dismissed'].includes(value.disposition) && !value.note?.trim())) throw new Error('Invalid finding assessment');
    }
    triage = saved.triage;
  } catch (error) { if (error.code !== 'ENOENT') inputIssues.push('Finding assessments are unreadable or invalid.'); }
  const findings = await collectFindings(root, runs, triage);
  const evidenceIssues = await verifyEvidence(path.join(root, run.id), run);
  return evaluateRelease(run, { evidenceIssues, findings, inputIssues });
}
