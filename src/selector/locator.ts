import { collapse, type VirtualDom, type VNode } from '../session/dom.js';
import { NodeType } from '../session/types.js';
import { accessibleName, isHidden, isLabelable, labelText, roleOf } from './aria.js';

export type Query =
  | { by: 'testid'; value: string }
  | { by: 'role'; role: string; name?: string; exact?: boolean }
  | { by: 'label'; text: string; exact?: boolean }
  | { by: 'placeholder'; text: string; exact?: boolean }
  | { by: 'text'; text: string; exact?: boolean }
  | { by: 'css'; selector: string };

export interface LocatorPart {
  query: Query;
  hasText?: string;
  /** Keep only elements that contain a descendant matching this query (`filter({ has })`). */
  has?: Query;
}

export interface Locator {
  /** Outer → inner. Usually one part; two when scoped to a container. */
  chain: LocatorPart[];
  nth?: number;
  confidence: 'high' | 'medium' | 'low';
  /** Human readable, e.g. `button "Add to cart" in listitem "Wireless Mouse"`. */
  description: string;
}

// ---------------------------------------------------------------------------
// Matching: emulate how the test runner resolves each query against the DOM.
// ---------------------------------------------------------------------------

const ci = (s: string) => s.toLowerCase();
const textMatch = (actual: string, expected: string, exact?: boolean) =>
  exact ? actual === expected : ci(actual).includes(ci(expected));

function matches(dom: VirtualDom, n: VNode, q: Query): boolean {
  if (n.type !== NodeType.Element) return false;
  switch (q.by) {
    case 'testid':
      return n.attributes['data-testid'] === q.value;
    case 'css':
      return matchesCss(dom, n, q.selector);
    default:
      break;
  }
  if (isHidden(dom, n)) return false;
  switch (q.by) {
    case 'role':
      if (roleOf(n) !== q.role) return false;
      return q.name === undefined || textMatch(accessibleName(dom, n), q.name, q.exact);
    case 'label': {
      if (!isLabelable(n) && !n.attributes['aria-label'] && !n.attributes['aria-labelledby']) return false;
      const names = [labelText(dom, n), n.attributes['aria-label'] ?? ''];
      if (n.attributes['aria-labelledby']) names.push(accessibleName(dom, n));
      return names.some((s) => s && textMatch(collapse(s), q.text, q.exact));
    }
    case 'placeholder':
      return Boolean(n.attributes.placeholder) && textMatch(collapse(n.attributes.placeholder!), q.text, q.exact);
    case 'text': {
      const own = dom.textContent(n);
      if (!textMatch(own, q.text, q.exact)) return false;
      // getByText resolves to the innermost element that carries the text.
      for (const c of n.children) {
        const child = dom.get(c);
        if (child?.type === NodeType.Element && !isHidden(dom, child) && textMatch(dom.textContent(child), q.text, q.exact))
          return false;
      }
      return true;
    }
  }
}

function matchesCss(dom: VirtualDom, n: VNode, selector: string): boolean {
  // We only ever generate `#id`, `[attr="v"]` or child paths from cssPath(); compare by regeneration.
  if (selector.startsWith('#')) return n.attributes.id === unescapeCss(selector.slice(1));
  const attr = /^\[([\w-]+)="(.*)"\]$/.exec(selector);
  if (attr) return n.attributes[attr[1]!] === attr[2];
  return cssPath(dom, n) === selector;
}

function findAll(dom: VirtualDom, q: Query, scope?: VNode, hasText?: string, has?: Query): VNode[] {
  const out: VNode[] = [];
  for (const el of dom.elements(scope)) {
    if (!matches(dom, el, q)) continue;
    if (hasText && !ci(dom.textContent(el)).includes(ci(hasText))) continue;
    if (has && !findAll(dom, has, el).length) continue;
    out.push(el);
  }
  return out;
}

/** Resolves a locator chain against the DOM. Exposed for tests and self-checks. */
export function resolve(dom: VirtualDom, loc: Pick<Locator, 'chain' | 'nth'>): VNode[] {
  let scopes: (VNode | undefined)[] = [undefined];
  for (const part of loc.chain) {
    const next: VNode[] = [];
    for (const s of scopes) next.push(...findAll(dom, part.query, s, part.hasText, part.has));
    scopes = [...new Set(next)];
  }
  const found = scopes.filter((x): x is VNode => Boolean(x));
  if (loc.nth !== undefined) return found[loc.nth] ? [found[loc.nth]!] : [];
  return found;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

const GENERATED_ID = /\d{3,}|:|^[a-f0-9]{6,}$|^(ember|react|radix|headlessui|mui)[-_]?/i;

function candidates(dom: VirtualDom, n: VNode): { q: Query; confidence: Locator['confidence'] }[] {
  const out: { q: Query; confidence: Locator['confidence'] }[] = [];
  const testid = n.attributes['data-testid'];
  if (testid) out.push({ q: { by: 'testid', value: testid }, confidence: 'high' });
  for (const attr of ['data-test', 'data-cy', 'data-qa']) {
    const v = n.attributes[attr];
    if (v) out.push({ q: { by: 'css', selector: `[${attr}="${v}"]` }, confidence: 'high' });
  }

  const role = roleOf(n);
  const name = accessibleName(dom, n);
  const label = labelText(dom, n) || n.attributes['aria-label'] || '';
  const isField = ['input', 'textarea', 'select'].includes(n.tagName);

  if (isField && label) out.push({ q: { by: 'label', text: collapse(label) }, confidence: 'high' });
  if (role && name && name.length <= 120) out.push({ q: { by: 'role', role, name }, confidence: 'high' });
  if (n.attributes.placeholder) out.push({ q: { by: 'placeholder', text: collapse(n.attributes.placeholder) }, confidence: 'medium' });
  if (!isField) {
    const text = dom.textContent(n);
    if (text && text.length <= 80) out.push({ q: { by: 'text', text }, confidence: 'medium' });
  }
  if (role) out.push({ q: { by: 'role', role }, confidence: 'medium' });
  const id = n.attributes.id;
  if (id && !GENERATED_ID.test(id)) out.push({ q: { by: 'css', selector: `#${escapeCss(id)}` }, confidence: 'medium' });
  out.push({ q: { by: 'css', selector: cssPath(dom, n) }, confidence: 'low' });
  return out;
}

function withExact(q: Query): Query | null {
  if (q.by === 'role' && q.name) return { ...q, exact: true };
  if (q.by === 'label' || q.by === 'placeholder' || q.by === 'text') return { ...q, exact: true };
  return null;
}

const CONTAINER_ROLES = new Set(['listitem', 'row', 'article', 'region', 'dialog', 'form', 'navigation', 'group', 'tabpanel', 'cell']);

/** Something that tells a container apart from its siblings: a heading, or else its leading text. */
function distinguishingText(dom: VirtualDom, container: VNode, target: VNode): string | null {
  const targetText = dom.textContent(target);
  for (const d of dom.descendants(container)) {
    if (d.type === NodeType.Element && roleOf(d) === 'heading') {
      const t = dom.textContent(d);
      if (t) return t.slice(0, 60);
    }
  }
  for (const d of dom.descendants(container)) {
    if (d.type !== NodeType.Text || d.isStyle) continue;
    const t = collapse(d.text);
    if (t.length >= 2 && t !== targetText) return t.slice(0, 60);
  }
  return null;
}

function containerParts(dom: VirtualDom, a: VNode, target: VNode): LocatorPart[] {
  const parts: LocatorPart[] = [];
  const testid = a.attributes['data-testid'];
  if (testid) parts.push({ query: { by: 'testid', value: testid } });
  const role = roleOf(a);
  if (role && CONTAINER_ROLES.has(role)) {
    const name = accessibleName(dom, a);
    if (name && name.length <= 60 && role !== 'listitem' && role !== 'cell') parts.push({ query: { by: 'role', role, name } });
    const text = distinguishingText(dom, a, target);
    if (text) parts.push({ query: { by: 'role', role }, hasText: text });
    // Substring matching makes "Product 1" also match "Product 10"; an exact heading does not.
    const heading = firstHeading(dom, a);
    if (heading) parts.push({ query: { by: 'role', role }, has: { by: 'role', role: 'heading', name: heading, exact: true } });
  }
  return parts;
}

function firstHeading(dom: VirtualDom, container: VNode): string | null {
  for (const d of dom.descendants(container)) {
    if (d.type === NodeType.Element && roleOf(d) === 'heading' && !isHidden(dom, d)) {
      const name = accessibleName(dom, d);
      if (name && name.length <= 80) return name;
    }
  }
  return null;
}

export function buildLocator(dom: VirtualDom, node: VNode): Locator {
  const cands = candidates(dom, node);

  // 1. A single (non-positional) query that is unique on the page.
  for (const c of cands.filter((x) => x.confidence !== 'low')) {
    for (const q of [c.q, withExact(c.q)]) {
      if (!q) continue;
      const found = findAll(dom, q);
      if (found.length === 1 && found[0] === node) return finish([{ query: q }], c.confidence);
    }
  }

  // 2. Scope the best semantic query to a nearby, uniquely identifiable container.
  const semantic = cands.filter((c) => c.q.by !== 'css' || c.confidence === 'high');
  for (const c of semantic) {
    for (const a of dom.ancestors(node)) {
      if (a.tagName === 'body' || a.tagName === 'html') break;
      const inner = findAll(dom, c.q, a);
      if (inner.length !== 1 || inner[0] !== node) continue;
      for (const outer of containerParts(dom, a, node)) {
        const scoped = resolve(dom, { chain: [outer, { query: c.q }] });
        if (scoped.length === 1 && scoped[0] === node) return finish([outer, { query: c.q }], 'medium');
      }
    }
  }

  // 3. Positional fallback on the best query (more readable than a CSS path).
  const best = cands[0]!;
  const all = findAll(dom, best.q);
  const idx = all.indexOf(node);
  if (idx >= 0) return finish([{ query: best.q }], 'low', idx);
  const path = { by: 'css', selector: cssPath(dom, node) } as const;
  return finish([{ query: path }], 'low');

  function finish(chain: LocatorPart[], confidence: Locator['confidence'], nth?: number): Locator {
    return { chain, nth, confidence, description: describe(chain, nth) };
  }
}

export function describeQuery(q: Query): string {
  switch (q.by) {
    case 'testid':
      return `[data-testid="${q.value}"]`;
    case 'role':
      return q.name ? `${q.role} "${q.name}"` : q.role;
    case 'label':
      return `field labelled "${q.text}"`;
    case 'placeholder':
      return `field with placeholder "${q.text}"`;
    case 'text':
      return `text "${q.text}"`;
    case 'css':
      return q.selector;
  }
}

function describe(chain: LocatorPart[], nth?: number): string {
  const parts = chain.map(
    (p) => describeQuery(p.query) + (p.hasText ? ` "${p.hasText}"` : '') + (p.has ? ` with ${describeQuery(p.has)}` : ''),
  );
  const inner = parts.pop()!;
  const base = parts.length ? `${inner} in ${parts.reverse().join(' in ')}` : inner;
  return nth !== undefined ? `${base} (#${nth + 1})` : base;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function str(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
}

function renderQuery(q: Query): string {
  const exact = 'exact' in q && q.exact ? ', { exact: true }' : '';
  switch (q.by) {
    case 'testid':
      return `getByTestId(${str(q.value)})`;
    case 'role': {
      if (!q.name) return `getByRole(${str(q.role)})`;
      return `getByRole(${str(q.role)}, { name: ${str(q.name)}${q.exact ? ', exact: true' : ''} })`;
    }
    case 'label':
      return `getByLabel(${str(q.text)}${exact})`;
    case 'placeholder':
      return `getByPlaceholder(${str(q.text)}${exact})`;
    case 'text':
      return `getByText(${str(q.text)}${exact})`;
    case 'css':
      return `locator(${str(q.selector)})`;
  }
}

export function renderLocator(loc: Pick<Locator, 'chain' | 'nth'>, root = 'page'): string {
  let out = root;
  for (const p of loc.chain) {
    out += `.${renderQuery(p.query)}`;
    if (p.hasText) out += `.filter({ hasText: ${str(p.hasText)} })`;
    if (p.has) out += `.filter({ has: ${root}.${renderQuery(p.has)} })`;
  }
  if (loc.nth !== undefined) out += loc.nth === 0 ? '.first()' : `.nth(${loc.nth})`;
  return out;
}

// ---------------------------------------------------------------------------
// CSS helpers
// ---------------------------------------------------------------------------

function escapeCss(s: string): string {
  return s.replace(/([^\w-])/g, '\\$1');
}
function unescapeCss(s: string): string {
  return s.replace(/\\(.)/g, '$1');
}

export function cssPath(dom: VirtualDom, n: VNode): string {
  const segs: string[] = [];
  let cur: VNode | undefined = n;
  while (cur && cur.type === NodeType.Element && cur.tagName !== 'html') {
    const id = cur.attributes.id;
    if (id && !GENERATED_ID.test(id)) {
      segs.unshift(`#${escapeCss(id)}`);
      break;
    }
    const parent = dom.parent(cur);
    const tag = cur.tagName;
    if (parent) {
      const same = parent.children.map((c) => dom.get(c)).filter((c) => c?.tagName === tag);
      segs.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(cur) + 1})` : tag);
    } else segs.unshift(tag);
    cur = parent;
  }
  return segs.join(' > ');
}
