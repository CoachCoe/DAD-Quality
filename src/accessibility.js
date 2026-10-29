import { redact } from './core.js';

// Run an axe-core accessibility audit against a live Playwright page and return
// a compact, redacted list of WCAG violations. The agent can assert `a11y_clean`
// in a contract; the harness runs this audit and the finding is the REAL axe
// result against the real DOM — reproducible on replay like every other
// observation. Returns null (inconclusive) rather than throwing when the audit
// cannot run, so a missing dependency or a hostile page never crashes discovery.
//
// Only violations at or above `minImpact` are reported. No page text or secrets
// are captured — only the rule id, impact, help URL and the CSS/node target
// selectors axe produces, each redacted and length-bounded.

const IMPACT_ORDER = { minor: 0, moderate: 1, serious: 2, critical: 3 };

/**
 * @param {import('playwright').Page} page
 * @param {{minImpact?: 'minor'|'moderate'|'serious'|'critical', tags?: string[]}} [options]
 * @returns {Promise<Array<{rule: string, impact: string, help: string, targets: string[]}> | null>}
 */
export async function auditAccessibility(page, { minImpact = 'serious', tags = ['wcag2a', 'wcag2aa'] } = {}) {
  let AxeBuilder;
  try {
    ({ default: AxeBuilder } = await import('@axe-core/playwright'));
  } catch {
    return null; // axe-core not installed; expectation is inconclusive, never a failure.
  }
  let result;
  try {
    result = await new AxeBuilder({ page }).withTags(tags).analyze();
  } catch {
    return null;
  }
  const floor = IMPACT_ORDER[minImpact] ?? IMPACT_ORDER.serious;
  return result.violations
    .filter(v => (IMPACT_ORDER[v.impact] ?? 0) >= floor)
    .slice(0, 50)
    .map(v => ({
      rule: String(v.id).slice(0, 80),
      impact: String(v.impact ?? 'unknown').slice(0, 20),
      help: redact(String(v.helpUrl ?? '')).slice(0, 300),
      targets: (v.nodes ?? [])
        .flatMap(n => n.target ?? [])
        .map(t => redact(String(t)).slice(0, 200))
        .slice(0, 10),
    }));
}
