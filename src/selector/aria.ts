import { collapse, isNonRendered, type VirtualDom, type VNode } from '../session/dom.js';

/**
 * A pragmatic subset of the HTML-AAM implicit role mapping and the accname
 * algorithm. It only needs to agree with how the test runner resolves
 * `getByRole(role, { name })` for the elements users actually interact with.
 */
export function roleOf(n: VNode): string | null {
  const explicit = n.attributes.role?.trim().split(/\s+/)[0];
  if (explicit && explicit !== 'presentation' && explicit !== 'none') return explicit;

  switch (n.tagName) {
    case 'a':
    case 'area':
      return 'href' in n.attributes ? 'link' : null;
    case 'button':
      return 'button';
    case 'input':
      return inputRole(n);
    case 'textarea':
      return 'textbox';
    case 'select':
      return 'multiple' in n.attributes || Number(n.attributes.size ?? 0) > 1 ? 'listbox' : 'combobox';
    case 'option':
      return 'option';
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return 'heading';
    case 'li':
      return 'listitem';
    case 'ul':
    case 'ol':
    case 'menu':
      return 'list';
    case 'nav':
      return 'navigation';
    case 'main':
      return 'main';
    case 'header':
      return 'banner';
    case 'footer':
      return 'contentinfo';
    case 'aside':
      return 'complementary';
    case 'article':
      return 'article';
    case 'dialog':
      return 'dialog';
    case 'form':
      return 'form';
    case 'section':
      return 'region';
    case 'table':
      return 'table';
    case 'tr':
      return 'row';
    case 'td':
      return 'cell';
    case 'th':
      return 'columnheader';
    case 'img':
      return n.attributes.alt === '' ? null : 'img';
    case 'summary':
      return 'button';
    default:
      return null;
  }
}

function inputRole(n: VNode): string | null {
  const type = (n.attributes.type ?? 'text').toLowerCase();
  switch (type) {
    case 'button':
    case 'submit':
    case 'reset':
    case 'image':
      return 'button';
    case 'checkbox':
      return 'checkbox';
    case 'radio':
      return 'radio';
    case 'range':
      return 'slider';
    case 'number':
      return 'spinbutton';
    case 'search':
      return 'searchbox';
    case 'hidden':
    case 'file':
    case 'color':
    case 'date':
    case 'datetime-local':
    case 'month':
    case 'time':
    case 'week':
      return null;
    default:
      return 'textbox'; // text, email, tel, url, password(no role, but fine for getByLabel)
  }
}

const NAME_FROM_CONTENT = new Set([
  'button',
  'link',
  'heading',
  'option',
  'cell',
  'columnheader',
  'row',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'checkbox',
  'radio',
  'switch',
  'treeitem',
  'listitem',
  'tooltip',
]);

export function isLabelable(n: VNode): boolean {
  return ['input', 'textarea', 'select', 'button', 'meter', 'output', 'progress'].includes(n.tagName);
}

/** Text of <label> elements associated with a form control. */
export function labelText(dom: VirtualDom, n: VNode): string {
  if (!isLabelable(n)) return '';
  const parts: string[] = [];
  const id = n.attributes.id;
  if (id) {
    for (const el of dom.elements()) {
      if (el.tagName === 'label' && el.attributes.for === id) parts.push(labelOwnText(dom, el, n));
    }
  }
  for (const a of dom.ancestors(n)) {
    if (a.tagName === 'label' && !a.attributes.for) {
      parts.push(labelOwnText(dom, a, n));
      break;
    }
  }
  return collapse(parts.join(' '));
}

/** Label text minus the control's own value (a wrapped <input> contributes nothing). */
function labelOwnText(dom: VirtualDom, label: VNode, control: VNode): string {
  if (!label.children.length) return '';
  const pieces: string[] = [];
  for (const c of label.children) {
    const child = dom.get(c);
    if (!child || child.id === control.id) continue;
    if (child.type === 3) pieces.push(child.text);
    else if (child.type === 2 && !['input', 'select', 'textarea'].includes(child.tagName)) pieces.push(dom.textContent(child));
  }
  return collapse(pieces.join(' '));
}

export function accessibleName(dom: VirtualDom, n: VNode): string {
  const labelledBy = n.attributes['aria-labelledby'];
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => dom.byId(id))
      .filter((x): x is VNode => Boolean(x))
      .map((x) => dom.textContent(x))
      .join(' ');
    if (collapse(text)) return collapse(text);
  }
  const aria = n.attributes['aria-label'];
  if (aria && collapse(aria)) return collapse(aria);

  if (n.tagName === 'input') {
    const type = (n.attributes.type ?? 'text').toLowerCase();
    if (['button', 'submit', 'reset'].includes(type)) {
      return collapse(n.attributes.value ?? (type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : ''));
    }
    if (type === 'image') return collapse(n.attributes.alt ?? '');
  }
  if (isLabelable(n)) {
    const label = labelText(dom, n);
    if (label) return label;
  }
  if (n.tagName === 'img' || n.tagName === 'area') return collapse(n.attributes.alt ?? '');

  const role = roleOf(n);
  if (role && NAME_FROM_CONTENT.has(role)) {
    const text = dom.textContent(n);
    if (text) return text;
  }
  if (n.attributes.title) return collapse(n.attributes.title);
  if (['input', 'textarea'].includes(n.tagName) && n.attributes.placeholder) return collapse(n.attributes.placeholder);
  return '';
}

/** Elements the test runner treats as hidden are never matched by role/text queries. */
export function isHidden(dom: VirtualDom, n: VNode): boolean {
  if (isNonRendered(n)) return true;
  for (const a of dom.ancestors(n)) if (isNonRendered(a)) return true;
  return false;
}

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'checkbox',
  'radio',
  'switch',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'slider',
  'spinbutton',
  'treeitem',
]);

/**
 * rrweb records the innermost target (`<span>` inside `<button>`, an `<svg>`
 * `<path>` in an icon button...). Users think in terms of the control, so walk
 * up to the closest interactive ancestor.
 */
export function interactiveTarget(dom: VirtualDom, n: VNode): VNode {
  let cur: VNode | undefined = n;
  let depth = 0;
  while (cur && depth < 8) {
    const role = roleOf(cur);
    if (role && INTERACTIVE_ROLES.has(role)) return cur;
    if (cur.tagName === 'label' || cur.tagName === 'summary') return cur;
    cur = dom.parent(cur);
    depth++;
  }
  return n;
}
