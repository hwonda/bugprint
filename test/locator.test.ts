import { beforeEach, describe, expect, it } from 'vitest';
import { VirtualDom } from '../src/session/dom.js';
import { buildLocator, renderLocator, resolve } from '../src/selector/locator.js';
import { byAttr, doc, h, resetIds } from './helpers.js';

beforeEach(resetIds);

const locate = (root: ReturnType<typeof doc>, id: number) => {
  const dom = VirtualDom.fromSnapshot(root);
  const loc = buildLocator(dom, dom.get(id)!);
  expect(resolve(dom, loc).map((n) => n.id)).toEqual([id]); // always resolves back to the same node
  return { loc, code: renderLocator(loc) };
};

describe('buildLocator', () => {
  it('prefers data-testid', () => {
    const root = doc(h('button', { 'data-testid': 'save' }, 'Save'));
    expect(locate(root, byAttr(root, 'data-testid', 'save').id).code).toBe("page.getByTestId('save')");
  });

  it('uses role + accessible name for buttons and links', () => {
    const root = doc(h('button', { k: 'b' }, ' Sign ', h('span', {}, 'in')), h('a', { href: '/x', k: 'a' }, 'Docs'));
    expect(locate(root, byAttr(root, 'k', 'b').id).code).toBe("page.getByRole('button', { name: 'Sign in' })");
    expect(locate(root, byAttr(root, 'k', 'a').id).code).toBe("page.getByRole('link', { name: 'Docs' })");
  });

  it('uses the label for form fields (for= and wrapping)', () => {
    const root = doc(
      h('label', { for: 'em' }, 'Email'),
      h('input', { id: 'em', type: 'email' }),
      h('label', {}, h('input', { type: 'checkbox', k: 'cb' }), ' Remember me'),
    );
    expect(locate(root, byAttr(root, 'id', 'em').id).code).toBe("page.getByLabel('Email')");
    expect(locate(root, byAttr(root, 'k', 'cb').id).code).toBe("page.getByLabel('Remember me')");
  });

  it('adds exact: true when a substring match would be ambiguous', () => {
    const root = doc(h('button', { k: '1' }, 'Save'), h('button', { k: '2' }, 'Save draft'));
    expect(locate(root, byAttr(root, 'k', '1').id).code).toBe("page.getByRole('button', { name: 'Save', exact: true })");
  });

  it('scopes duplicate controls to their container by its heading', () => {
    const card = (title: string, k: string) => h('li', {}, h('h2', {}, title), h('button', { k }, 'Add to cart'));
    const root = doc(h('ul', {}, card('Keyboard', 'a'), card('Mouse', 'b')));
    expect(locate(root, byAttr(root, 'k', 'b').id).code).toBe(
      "page.getByRole('listitem').filter({ hasText: 'Mouse' }).getByRole('button', { name: 'Add to cart' })",
    );
  });

  it('falls back to a positional locator when nothing distinguishes the elements', () => {
    const root = doc(h('div', {}, h('button', { k: 'a' }, 'Go')), h('div', {}, h('button', { k: 'b' }, 'Go')));
    const { loc, code } = locate(root, byAttr(root, 'k', 'b').id);
    expect(code).toBe("page.getByRole('button', { name: 'Go' }).nth(1)");
    expect(loc.confidence).toBe('low');
  });

  it('ignores hidden duplicates the runner would not match', () => {
    const root = doc(h('button', { hidden: '' }, 'Pay'), h('button', { k: 'v' }, 'Pay'));
    expect(locate(root, byAttr(root, 'k', 'v').id).code).toBe("page.getByRole('button', { name: 'Pay' })");
  });

  it('escapes quotes in generated strings', () => {
    const root = doc(h('button', { k: 'q' }, "Don't save"));
    expect(locate(root, byAttr(root, 'k', 'q').id).code).toBe("page.getByRole('button', { name: 'Don\\'t save' })");
  });
});
