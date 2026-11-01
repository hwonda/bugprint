import { redactValue } from '../codegen/redact.js';
import type { Flow, Step } from './extract.js';

export function fmtTime(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
}

export function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search + u.hash;
  } catch {
    return url;
  }
}

/** One-line description of a step. Typed values are PII-redacted unless `redact` is false. */
export function describeStep(s: Step, redact = true): string {
  switch (s.kind) {
    case 'goto':
      return `open ${pathOf(s.url)}`;
    case 'reload':
      return 'reload page';
    case 'expectUrl':
      return `→ navigated to ${pathOf(s.url)}`;
    case 'click':
      return `click ${s.target.locator.description}`;
    case 'dblclick':
      return `double-click ${s.target.locator.description}`;
    case 'rightclick':
      return `right-click ${s.target.locator.description}`;
    case 'fill':
      return `type ${s.masked ? '<masked>' : JSON.stringify(redact ? redactValue(s.value) : s.value)} into ${s.target.locator.description}`;
    case 'check':
      return `check ${s.target.locator.description}`;
    case 'uncheck':
      return `uncheck ${s.target.locator.description}`;
    case 'select':
      return `select ${JSON.stringify(s.value)} in ${s.target.locator.description}`;
  }
}

/** Compact, token-cheap timeline an agent can read before deciding what to generate. */
export function summarizeFlow(flow: Flow): string {
  const lines: string[] = [];
  lines.push(`Session ${flow.sessionId} · ${fmtTime(flow.durationMs)} · ${flow.steps.length} steps · ${flow.pages.length} page(s)`);
  lines.push(`Pages: ${flow.pages.map(pathOf).join(' → ') || '(none)'}`);
  lines.push('');
  const signalsByStep = new Map<string | null, typeof flow.signals>();
  for (const sig of flow.signals) {
    const list = signalsByStep.get(sig.afterStepId) ?? [];
    list.push(sig);
    signalsByStep.set(sig.afterStepId, list);
  }
  const printSignals = (key: string | null) => {
    for (const sig of signalsByStep.get(key) ?? []) {
      const where = sig.trace[0] ? `  @ ${sig.trace[0]}` : '';
      lines.push(`[${fmtTime(sig.t)}]   ⚠ ${sig.kind}: ${sig.message}${where}`);
    }
  };
  printSignals(null);
  for (const s of flow.steps) {
    lines.push(`[${fmtTime(s.t)}] ${s.id.padEnd(4)} ${describeStep(s)}`);
    printSignals(s.id);
  }
  if (flow.warnings.length) {
    lines.push('');
    for (const w of flow.warnings) lines.push(`note: ${w}`);
  }
  return lines.join('\n');
}
