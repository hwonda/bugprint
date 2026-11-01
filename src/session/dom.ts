import { NodeType, type MutationData, type SerializedNode } from './types.js';

/**
 * A lightweight, queryable mirror of the recorded page.
 *
 * rrweb records a full DOM snapshot on load and then only diffs (mutations).
 * To turn "click on node #57" into a stable locator we need to know what node
 * #57 looked like *at that moment*, so we replay snapshots + mutations into this
 * structure while walking the event stream.
 */
export interface VNode {
  id: number;
  type: number;
  tagName: string; // lower-case, '' for non-elements
  attributes: Record<string, string>;
  text: string; // for text nodes
  parentId: number | null;
  children: number[];
  isStyle: boolean;
}

export class VirtualDom {
  readonly nodes = new Map<number, VNode>();
  /** Nodes removed from the tree, kept so late lookups still describe them. */
  private readonly detached = new Map<number, VNode>();
  rootId: number | null = null;

  static fromSnapshot(root: SerializedNode): VirtualDom {
    const dom = new VirtualDom();
    dom.rootId = root.id;
    dom.insert(root, null);
    return dom;
  }

  get(id: number): VNode | undefined {
    return this.nodes.get(id) ?? this.detached.get(id);
  }

  isAttached(id: number): boolean {
    return this.nodes.has(id);
  }

  private insert(node: SerializedNode, parentId: number | null, nextId: number | null = null): void {
    const v: VNode = {
      id: node.id,
      type: node.type,
      tagName: node.type === NodeType.Element ? String(node.tagName ?? '').toLowerCase() : '',
      attributes: normalizeAttributes(node.attributes),
      text: node.textContent ?? '',
      parentId,
      children: [],
      isStyle: Boolean(node.isStyle),
    };
    this.detached.delete(v.id);
    this.nodes.set(v.id, v);
    if (parentId !== null) {
      const parent = this.nodes.get(parentId);
      if (parent) {
        const idx = nextId === null ? -1 : parent.children.indexOf(nextId);
        if (idx === -1) parent.children.push(v.id);
        else parent.children.splice(idx, 0, v.id);
      }
    }
    for (const child of node.childNodes ?? []) this.insert(child, v.id);
  }

  private remove(id: number): void {
    const node = this.nodes.get(id);
    if (!node) return;
    if (node.parentId !== null) {
      const parent = this.nodes.get(node.parentId);
      if (parent) parent.children = parent.children.filter((c) => c !== id);
    }
    const stack = [id];
    while (stack.length) {
      const cur = this.nodes.get(stack.pop()!);
      if (!cur) continue;
      this.nodes.delete(cur.id);
      this.detached.set(cur.id, cur);
      stack.push(...cur.children);
    }
  }

  applyMutation(m: MutationData): void {
    for (const r of m.removes ?? []) this.remove(r.id);
    // rrweb may emit adds whose parent arrives later in the same batch; retry until stable.
    let pending = [...(m.adds ?? [])];
    for (let pass = 0; pending.length && pass < 5; pass++) {
      const next: typeof pending = [];
      for (const add of pending) {
        if (this.nodes.has(add.parentId)) {
          if (this.nodes.has(add.node.id)) this.remove(add.node.id);
          this.insert(add.node, add.parentId, add.nextId);
        } else next.push(add);
      }
      pending = next;
    }
    for (const t of m.texts ?? []) {
      const n = this.nodes.get(t.id);
      if (n) n.text = t.value ?? '';
    }
    for (const a of m.attributes ?? []) {
      const n = this.nodes.get(a.id);
      if (!n) continue;
      for (const [k, v] of Object.entries(a.attributes)) {
        if (v === null) delete n.attributes[k];
        else if (typeof v === 'string') n.attributes[k] = v;
        // object values are style diffs; irrelevant for locators
      }
    }
  }

  /** Records the current value of form controls so labels like `selected` stay in sync. */
  setValue(id: number, value: string, checked?: boolean): void {
    const n = this.nodes.get(id);
    if (!n) return;
    n.attributes.value = value;
    if (checked !== undefined) {
      if (checked) n.attributes.checked = '';
      else delete n.attributes.checked;
    }
  }

  parent(n: VNode): VNode | undefined {
    return n.parentId === null ? undefined : this.get(n.parentId);
  }

  *ancestors(n: VNode): Generator<VNode> {
    let cur = this.parent(n);
    while (cur) {
      yield cur;
      cur = this.parent(cur);
    }
  }

  *descendants(n: VNode): Generator<VNode> {
    const stack = [...n.children].reverse();
    while (stack.length) {
      const cur = this.get(stack.pop()!);
      if (!cur) continue;
      yield cur;
      for (let i = cur.children.length - 1; i >= 0; i--) stack.push(cur.children[i]!);
    }
  }

  /** All attached element nodes in document order. */
  *elements(scope?: VNode): Generator<VNode> {
    const root = scope ?? (this.rootId !== null ? this.get(this.rootId) : undefined);
    if (!root) return;
    for (const n of this.descendants(root)) if (n.type === NodeType.Element) yield n;
  }

  /** Visible text content, whitespace-collapsed, skipping script/style/hidden subtrees. */
  textContent(n: VNode): string {
    const parts: string[] = [];
    const walk = (cur: VNode) => {
      if (cur.type === NodeType.Text) {
        if (!cur.isStyle) parts.push(cur.text);
        return;
      }
      if (cur.type !== NodeType.Element && cur.type !== NodeType.Document) return;
      if (isNonRendered(cur)) return;
      if (cur.tagName === 'img' && cur.attributes.alt) parts.push(` ${cur.attributes.alt} `);
      for (const c of cur.children) {
        const child = this.get(c);
        if (child) walk(child);
      }
    };
    walk(n);
    return collapse(parts.join(''));
  }

  byId(domId: string): VNode | undefined {
    for (const el of this.elements()) if (el.attributes.id === domId) return el;
    return undefined;
  }
}

const NON_RENDERED = new Set(['script', 'style', 'template', 'noscript', 'head', 'meta', 'link', 'title']);

export function isNonRendered(n: VNode): boolean {
  if (NON_RENDERED.has(n.tagName)) return true;
  if ('hidden' in n.attributes) return true;
  if (n.attributes['aria-hidden'] === 'true') return true;
  if (n.tagName === 'input' && n.attributes.type === 'hidden') return true;
  return false;
}

export function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function normalizeAttributes(attrs: SerializedNode['attributes']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === false) continue;
    if (k.startsWith('rr_')) continue; // rrweb internal (rr_width, rr_dataURL, ...)
    out[k] = v === true ? '' : String(v);
  }
  return out;
}
