import { VirtualDom, type VNode } from '../session/dom.js';
import type { Session } from '../session/load.js';
import { EventType, IncrementalSource, MouseInteraction, type MutationData, type RrwebEvent } from '../session/types.js';
import { interactiveTarget } from '../selector/aria.js';
import { buildLocator, renderLocator, type Locator } from '../selector/locator.js';

export interface Target {
  nodeId: number;
  tag: string;
  locator: Locator;
  /** Ready-to-paste locator expression, e.g. `page.getByRole('button', { name: 'Apply' })`. */
  code: string;
}

interface StepBase {
  id: string;
  /** Milliseconds since the recording started. */
  t: number;
  url: string;
}

export type Step =
  | (StepBase & { kind: 'goto' })
  | (StepBase & { kind: 'reload' })
  | (StepBase & { kind: 'expectUrl' })
  | (StepBase & { kind: 'click' | 'dblclick' | 'rightclick'; target: Target })
  | (StepBase & { kind: 'fill'; target: Target; value: string; masked: boolean })
  | (StepBase & { kind: 'check' | 'uncheck'; target: Target })
  | (StepBase & { kind: 'select'; target: Target; value: string })
  | (StepBase & { kind: 'press'; key: string; target: Target | null })
  | (StepBase & { kind: 'back' | 'forward' });

/** An API call captured by the rrweb network plugin (`rrweb/network@1`). */
export interface NetworkCall {
  t: number;
  method: string;
  url: string;
  status: number;
  initiatorType: string;
  contentType: string | null;
  responseBody: string | null;
}

export interface InitialStorage {
  origin: string;
  localStorage: Record<string, string>;
  cookies: Record<string, string>;
  /** Keys the recorder refused to capture because they look sensitive. */
  masked: string[];
}

export interface Signal {
  t: number;
  kind: 'uncaught-error' | 'console-error' | 'console-warn' | 'network-error' | 'custom';
  message: string;
  trace: string[];
  /** The step that was performed right before this signal, if any. */
  afterStepId: string | null;
  url: string;
}

export interface Flow {
  sessionId: string;
  startUrl: string;
  pages: string[];
  durationMs: number;
  /** Epoch ms when the recording started (used to freeze the clock on replay). */
  recordedAt: number;
  steps: Step[];
  signals: Signal[];
  /** fetch/XHR calls with their recorded responses, in order. */
  network: NetworkCall[];
  /** localStorage and cookies when the recording started (bugprint recorder plugin). */
  initialStorage: InitialStorage | null;
  /** Which optional recorder plugins were present. */
  capabilities: { console: boolean; network: boolean; interaction: boolean };
  warnings: string[];
}

export interface ExtractOptions {
  /** Only keep steps within this window (ms since recording start). DOM state is still replayed. */
  fromMs?: number;
  toMs?: number;
}

const NAV_WINDOW_MS = 4000;
/** A keyboard-activated control (Enter on a button / implicit form submit) also fires a click. */
const SYNTHETIC_CLICK_MS = 150;
const API_INITIATORS = new Set(['fetch', 'xmlhttprequest']);

type DraftStep = Step extends infer S ? (S extends Step ? Omit<S, 'id'> : never) : never;

export function extractFlow(session: Session, opts: ExtractOptions = {}): Flow {
  const start = session.startedAt;
  const steps: DraftStep[] = [];
  const signals: (Omit<Signal, 'afterStepId'> & { stepIndex: number })[] = [];
  const warnings = new Set<string>();
  const pages: string[] = [];
  const network: NetworkCall[] = [];
  const capabilities = { console: false, network: false, interaction: false };
  let initialStorage: InitialStorage | null = null;

  let dom: VirtualDom | null = null;
  let href = '';
  let sawLoadSinceMeta = false;
  let lastActionAt = -Infinity;

  const target = (node: VNode): Target => {
    const locator = buildLocator(dom!, node);
    if (locator.confidence === 'low') warnings.add(`Low-confidence locator for ${locator.description}; consider adding a data-testid.`);
    return { nodeId: node.id, tag: node.tagName, locator, code: renderLocator(locator) };
  };
  const last = () => steps.at(-1);

  for (const ev of session.events) {
    const t = ev.timestamp - start;
    switch (ev.type) {
      case EventType.DomContentLoaded:
      case EventType.Load:
        sawLoadSinceMeta = true;
        break;

      case EventType.Meta: {
        const next = String(ev.data?.href ?? '');
        if (!next) break;
        if (!pages.includes(next)) pages.push(next);
        const prev = last();
        if (!href) {
          steps.push({ kind: 'goto', t, url: next });
        } else if (next !== href) {
          const causedByAction = t - lastActionAt <= NAV_WINDOW_MS && prev && prev.kind !== 'goto';
          steps.push({ kind: causedByAction ? 'expectUrl' : 'goto', t, url: next });
        } else if (sawLoadSinceMeta && !(t - lastActionAt <= NAV_WINDOW_MS)) {
          steps.push({ kind: 'reload', t, url: next });
        }
        // Same href without a page load is a periodic re-snapshot ("checkout"): not a navigation.
        href = next;
        sawLoadSinceMeta = false;
        break;
      }

      case EventType.FullSnapshot:
        dom = VirtualDom.fromSnapshot(ev.data.node);
        break;

      case EventType.IncrementalSnapshot:
        if (!dom) break;
        handleIncremental(ev, t);
        break;

      case EventType.Plugin:
        handlePlugin(ev, t);
        break;

      case EventType.Custom: {
        const tag = String(ev.data?.tag ?? '');
        if (/error|bug|exception/i.test(tag)) {
          signals.push({
            t,
            kind: 'custom',
            message: `${tag}: ${stringify(ev.data?.payload)}`,
            trace: [],
            url: href,
            stepIndex: steps.length - 1,
          });
        }
        break;
      }
    }
  }

  function handleIncremental(ev: RrwebEvent, t: number) {
    const d = ev.data;
    switch (d.source) {
      case IncrementalSource.Mutation:
        dom!.applyMutation(d as MutationData);
        return;

      case IncrementalSource.MouseInteraction: {
        const raw = dom!.get(d.id);
        if (!raw) {
          if ([MouseInteraction.Click, MouseInteraction.DblClick].includes(d.type)) warnings.add(`Click on unknown node #${d.id} skipped.`);
          return;
        }
        if (d.type === MouseInteraction.Click) {
          const p = last();
          if (p?.kind === 'press' && /(^|\+)(Enter| )$/.test(p.key) && t - p.t <= SYNTHETIC_CLICK_MS) return;
          const node = interactiveTarget(dom!, raw);
          steps.push({ kind: 'click', t, url: href, target: target(node) });
          lastActionAt = t;
        } else if (d.type === MouseInteraction.DblClick) {
          const node = interactiveTarget(dom!, raw);
          // The browser fires click, click, dblclick. Collapse them into one step.
          for (let i = 0; i < 2; i++) {
            const p = last();
            if (p?.kind === 'click' && p.target.nodeId === node.id && t - p.t < 800) steps.pop();
          }
          steps.push({ kind: 'dblclick', t, url: href, target: target(node) });
          lastActionAt = t;
        } else if (d.type === MouseInteraction.ContextMenu) {
          const node = interactiveTarget(dom!, raw);
          steps.push({ kind: 'rightclick', t, url: href, target: target(node) });
          lastActionAt = t;
        }
        return;
      }

      case IncrementalSource.Input: {
        const node = dom!.get(d.id);
        if (!node) return;
        const text = String(d.text ?? '');
        dom!.setValue(node.id, text, d.isChecked);
        lastActionAt = t;
        const type = (node.attributes.type ?? '').toLowerCase();

        if (node.tagName === 'input' && (type === 'checkbox' || type === 'radio')) {
          if (type === 'radio' && !d.isChecked) return; // the sibling that got unchecked
          dropClicksLeadingTo(node, t);
          steps.push({ kind: d.isChecked ? 'check' : 'uncheck', t, url: href, target: target(node) });
          return;
        }
        if (node.tagName === 'select') {
          const p = last();
          if (p?.kind === 'select' && p.target.nodeId === node.id) steps.pop();
          dropClicksLeadingTo(node, t);
          steps.push({ kind: 'select', t, url: href, target: target(node), value: text });
          return;
        }
        // Text-like field: keystrokes arrive as successive full values; keep only the final one.
        const p = last();
        if (p?.kind === 'fill' && p.target.nodeId === node.id) {
          p.value = text;
          p.t = t;
          p.masked = isMasked(node, text);
          return;
        }
        dropClicksLeadingTo(node, t);
        steps.push({ kind: 'fill', t, url: href, target: target(node), value: text, masked: isMasked(node, text) });
        return;
      }
    }
  }

  /** A click that only focused a field (or toggled it via its label) is implied by fill/check. */
  function dropClicksLeadingTo(node: VNode, t: number) {
    const p = last();
    if (p?.kind !== 'click' || t - p.t > 10_000) return;
    if (p.target.nodeId === node.id) {
      steps.pop();
      return;
    }
    const clicked = dom!.get(p.target.nodeId);
    if (clicked?.tagName === 'label' && labelTargets(clicked, node)) steps.pop();
  }

  function labelTargets(label: VNode, control: VNode): boolean {
    if (label.attributes.for) return label.attributes.for === control.attributes.id;
    for (const a of dom!.ancestors(control)) if (a.id === label.id) return true;
    return false;
  }

  function handlePlugin(ev: RrwebEvent, t: number) {
    const plugin = String(ev.data?.plugin ?? '');
    const p = ev.data?.payload ?? {};
    if (plugin.startsWith('rrweb/console')) {
      capabilities.console = true;
      const level = String(p.level ?? '');
      if (level !== 'error' && level !== 'warn' && level !== 'assert') return;
      const message = (Array.isArray(p.payload) ? p.payload : [p.payload]).map(unquote).join(' ');
      const kind: Signal['kind'] = /^Uncaught\b/.test(message) ? 'uncaught-error' : level === 'warn' ? 'console-warn' : 'console-error';
      signals.push({ t, kind, message, trace: Array.isArray(p.trace) ? p.trace.map(String) : [], url: href, stepIndex: steps.length - 1 });
    } else if (plugin.startsWith('rrweb/network')) {
      capabilities.network = true;
      for (const r of Array.isArray(p.requests) ? p.requests : []) handleRequest(r, t);
    } else if (plugin.startsWith('bugprint/interaction')) {
      capabilities.interaction = true;
      handleInteraction(p, t);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function handleRequest(r: any, t: number) {
    const initiatorType = String(r.initiatorType ?? '');
    if (!API_INITIATORS.has(initiatorType)) return;
    const url = String(r.name ?? r.url ?? '');
    if (!url) return;
    const status = Number(r.status ?? 0);
    const headers: Record<string, string> = r.responseHeaders ?? {};
    const contentType = Object.entries(headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? null;
    const body = r.responseBody;
    const call: NetworkCall = {
      t,
      method: String(r.method ?? 'GET').toUpperCase(),
      url: absolute(url),
      status,
      initiatorType,
      contentType,
      responseBody: body === undefined || body === null ? null : typeof body === 'string' ? body : stringify(body),
    };
    network.push(call);
    if (status === 0 || status >= 500) {
      signals.push({
        t,
        kind: 'network-error',
        message: `${call.method} ${pathOfUrl(call.url)} → ${status || 'failed'}`,
        trace: [],
        url: href,
        stepIndex: steps.length - 1,
      });
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function handleInteraction(p: any, t: number) {
    if (p.type === 'storage') {
      // Only the first snapshot describes the state the session *started* with.
      if (!initialStorage) {
        initialStorage = {
          origin: String(p.origin ?? ''),
          localStorage: stringRecord(p.localStorage),
          cookies: stringRecord(p.cookies),
          masked: Array.isArray(p.masked) ? p.masked.map(String) : [],
        };
      }
      return;
    }
    if (p.type === 'key') {
      const node = typeof p.id === 'number' ? dom?.get(p.id) : undefined;
      const focusable = node && node.tagName !== 'body' && node.tagName !== 'html' ? node : undefined;
      steps.push({ kind: 'press', t, url: href, key: String(p.key), target: focusable ? target(focusable) : null });
      lastActionAt = t;
      return;
    }
    if (p.type === 'nav') {
      const next = String(p.href ?? '');
      if (!next || next === href) return;
      if (!pages.includes(next)) pages.push(next);
      if (p.via === 'back' || p.via === 'forward') steps.push({ kind: p.via, t, url: next });
      else steps.push({ kind: 'expectUrl', t, url: next });
      href = next;
    }
  }

  function absolute(u: string): string {
    try {
      return new URL(u, href || undefined).href;
    } catch {
      return u;
    }
  }

  // ---- windowing + ids ------------------------------------------------------
  const inWindow = (t: number) => (opts.fromMs === undefined || t >= opts.fromMs) && (opts.toMs === undefined || t <= opts.toMs);
  const kept = steps.map((s, i) => ({ s, i })).filter(({ s }) => inWindow(s.t));
  if (kept.length && kept[0]!.s.kind !== 'goto') {
    const url = kept[0]!.s.url;
    kept.unshift({ s: { kind: 'goto', t: kept[0]!.s.t, url }, i: -1 });
    warnings.add('Steps before the selected window were dropped; app state they created (cart, login, ...) may be missing.');
  }
  const idOf = new Map<number, string>();
  const finalSteps = kept.map(({ s, i }, n) => {
    const id = `s${n + 1}`;
    if (i >= 0) idOf.set(i, id);
    return { ...s, id } as Step;
  });

  const finalSignals: Signal[] = signals
    .filter((s) => inWindow(s.t))
    .map(({ stepIndex, ...s }) => {
      let id: string | null = null;
      for (let i = stepIndex; i >= 0 && !id; i--) id = idOf.get(i) ?? null;
      return { ...s, afterStepId: id };
    });

  if (!finalSignals.some((s) => s.kind !== 'console-warn' && s.kind !== 'network-error')) {
    warnings.add(
      'No error was captured in this recording. The generated test will replay the steps but needs an assertion that describes the bug.',
    );
  }

  return {
    sessionId: session.id,
    startUrl: finalSteps[0]?.url ?? href,
    pages,
    durationMs: session.durationMs,
    recordedAt: session.startedAt,
    steps: finalSteps,
    signals: finalSignals,
    network,
    initialStorage,
    capabilities,
    warnings: [...warnings],
  };
}

function stringRecord(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (typeof x === 'string') out[k] = x;
  return out;
}

function pathOfUrl(u: string): string {
  try {
    const x = new URL(u);
    return x.pathname + x.search;
  } catch {
    return u;
  }
}

function isMasked(node: VNode, value: string): boolean {
  return (node.attributes.type ?? '').toLowerCase() === 'password' || (value.length > 0 && /^\*+$/.test(value));
}

function unquote(v: unknown): string {
  if (typeof v !== 'string') return stringify(v);
  try {
    const parsed = JSON.parse(v);
    return typeof parsed === 'string' ? parsed : v;
  } catch {
    return v;
  }
}

function stringify(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
