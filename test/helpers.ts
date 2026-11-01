import type { RrwebEvent, SerializedNode } from '../src/session/types.js';

let nextId = 1;
export function resetIds() {
  nextId = 1;
}

type Child = SerializedNode | string;

/** Tiny hyperscript for rrweb serialized nodes: h('button', { id: 'x' }, 'Save'). */
export function h(tagName: string, attributes: Record<string, string> = {}, ...children: Child[]): SerializedNode {
  return {
    type: 2,
    id: nextId++,
    tagName,
    attributes,
    childNodes: children.map((c) => (typeof c === 'string' ? { type: 3, id: nextId++, textContent: c } : c)),
  };
}

export function doc(...body: Child[]): SerializedNode {
  const html = h('html', {}, h('head', {}, h('title', {}, 'T')), h('body', {}, ...body));
  return { type: 0, id: nextId++, childNodes: [html] };
}

export function find(root: SerializedNode, pred: (n: SerializedNode) => boolean): SerializedNode {
  const stack = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (pred(n)) return n;
    stack.push(...(n.childNodes ?? []));
  }
  throw new Error('node not found');
}

export const byAttr = (root: SerializedNode, k: string, v: string) => find(root, (n) => n.attributes?.[k] === v);

export class Rec {
  events: RrwebEvent[] = [];
  t = 1_700_000_000_000;
  push(type: number, data: unknown, dt = 100) {
    this.t += dt;
    this.events.push({ type, timestamp: this.t, data });
    return this;
  }
  page(href: string, node: SerializedNode) {
    this.push(1, {}, 10);
    this.push(4, { href, width: 1280, height: 720 }, 1);
    return this.push(2, { node, initialOffset: { top: 0, left: 0 } }, 1);
  }
  click(id: number, dt = 300) {
    this.push(3, { source: 2, type: 1, id }, dt);
    this.push(3, { source: 2, type: 0, id }, 1);
    return this.push(3, { source: 2, type: 2, id, x: 1, y: 1 }, 1);
  }
  type(id: number, text: string) {
    for (let i = 1; i <= text.length; i++) this.push(3, { source: 5, id, text: text.slice(0, i), isChecked: false }, 40);
    return this;
  }
  input(id: number, text: string, isChecked = false) {
    return this.push(3, { source: 5, id, text, isChecked }, 50);
  }
  error(message: string, trace: string[] = []) {
    return this.push(6, { plugin: 'rrweb/console@1', payload: { level: 'error', trace, payload: [JSON.stringify(message)] } }, 5);
  }
  mutate(data: Record<string, unknown>) {
    return this.push(3, { source: 0, adds: [], removes: [], texts: [], attributes: [], ...data }, 20);
  }
}
