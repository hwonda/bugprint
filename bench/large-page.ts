// Measures flow extraction on a large page: N product cards, each with an
// identically named "Add to cart" button (forces container scoping), plus 20 clicks.
// Usage: npx tsx bench/large-page.ts [cards...]
import { extractFlow } from '../src/flow/extract.js';
import { VirtualDom } from '../src/session/dom.js';
import { resolve } from '../src/selector/locator.js';
import { createSession, parseEvents } from '../src/session/load.js';
import type { SerializedNode } from '../src/session/types.js';

function build(cards: number) {
  let id = 1;
  const el = (tagName: string, attributes: Record<string, string>, ...kids: (SerializedNode | string)[]): SerializedNode => ({
    type: 2,
    id: id++,
    tagName,
    attributes,
    childNodes: kids.map((k) => (typeof k === 'string' ? { type: 3, id: id++, textContent: k } : k)),
  });
  const buttons: number[] = [];
  const items = Array.from({ length: cards }, (_, i) => {
    const btn = el('button', {}, 'Add to cart');
    buttons.push(btn.id);
    return el(
      'li',
      { class: 'card' },
      el('h2', {}, `Product ${i}`),
      el('p', { class: 'price' }, `$${i}`),
      el('div', { class: 'actions' }, btn, el('a', { href: `/p/${i}` }, 'Details')),
    );
  });
  const root: SerializedNode = {
    type: 0,
    id: id++,
    childNodes: [el('html', {}, el('head', {}), el('body', {}, el('main', {}, el('ul', {}, ...items))))],
  };
  let t = 1_700_000_000_000;
  const events: unknown[] = [
    { type: 4, timestamp: t, data: { href: 'https://shop.test/' } },
    { type: 2, timestamp: (t += 5), data: { node: root } },
  ];
  for (let k = 0; k < 20; k++) {
    const target = buttons[k === 0 ? 1 : Math.floor((k * 7919) % cards)]!; // first click: Product 1 (substring of Product 1x)
    events.push({ type: 3, timestamp: (t += 300), data: { source: 2, type: 2, id: target, x: 1, y: 1 } });
  }
  return { events, nodes: id };
}

for (const cards of process.argv.slice(2).map(Number).filter(Boolean).length ? process.argv.slice(2).map(Number) : [100, 500, 2000]) {
  const { events, nodes } = build(cards);
  const session = createSession(parseEvents(events), 'bench');
  const t0 = performance.now();
  const flow = extractFlow(session);
  const ms = performance.now() - t0;
  // Correctness: every locator must resolve to exactly the clicked node.
  const dom = VirtualDom.fromSnapshot((events[1] as { data: { node: SerializedNode } }).data.node);
  let wrong = 0;
  const kinds = new Map<string, number>();
  for (const s of flow.steps) {
    if (!('target' in s) || !s.target) continue;
    const hit = resolve(dom, s.target.locator);
    if (hit.length !== 1 || hit[0]!.id !== s.target.nodeId) wrong++;
    const shape = s.target.locator.nth !== undefined ? 'nth' : s.target.locator.chain.length > 1 ? 'scoped' : 'single';
    kinds.set(shape, (kinds.get(shape) ?? 0) + 1);
  }
  const sample =
    flow.steps.find((s) => s.kind === 'click' && 'target' in s && /Product 1\b|Product 1'/.test(s.target.code)) ??
    flow.steps.find((s) => s.kind === 'click');
  console.log(
    `${String(cards).padStart(5)} cards · ${String(nodes).padStart(6)} nodes · 20 clicks → ${ms.toFixed(0).padStart(6)} ms (${(ms / 20).toFixed(1)} ms/click) · wrong=${wrong} · ${[...kinds].map(([k, v]) => `${k}=${v}`).join(' ')}\n        e.g. ${sample && 'target' in sample ? sample.target.code : ''}`,
  );
}
