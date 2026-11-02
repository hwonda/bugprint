/**
 * bugprint recorder plugin for rrweb (browser code, no dependencies).
 *
 * rrweb records the DOM but not two things a reproduction usually needs:
 *  - key presses that *do* something (Enter to submit, Escape to close, shortcuts)
 *  - client-side route changes (history.pushState / back / forward)
 *
 *   import { record } from 'rrweb';
 *   import { getRecordBugprintPlugin } from 'bugprint/recorder';
 *   record({ emit, plugins: [getRecordBugprintPlugin()] });
 */

export const PLUGIN_NAME = 'bugprint/interaction@1';

export type InteractionPayload =
  | { type: 'storage'; origin: string; localStorage: Record<string, string>; cookies: Record<string, string>; masked: string[] }
  | { type: 'key'; key: string; id: number | null }
  | { type: 'nav'; href: string; via: 'push' | 'replace' | 'back' | 'forward' | 'pop' };

export interface BugprintRecordOptions {
  /** Keys recorded on their own. Printable characters are never recorded (rrweb already has the value). */
  keys?: string[];
  /** Record Ctrl/Meta/Alt + key shortcuts. Default true. */
  shortcuts?: boolean;
  /** Snapshot localStorage and readable cookies when recording starts. Default true. */
  storage?: boolean;
  /**
   * Extra storage keys never captured, on top of the built-in check (token, secret, password,
   * sessionId, apiKey, ...). Their names are reported; their values never leave the browser.
   */
  sensitiveKeys?: RegExp;
  /** Skip values longer than this many characters. Default 20000. */
  maxValueLength?: number;
}

// Must match isSensitiveKey() in src/codegen/secrets.ts (a test checks they agree).
// Duplicated because this file is shipped to browsers on its own, without imports.
const WORDS = [
  'token',
  'tokens',
  'secret',
  'secrets',
  'password',
  'passwd',
  'pwd',
  'jwt',
  'credential',
  'credentials',
  'csrf',
  'xsrf',
  'sid',
  'apikey',
  'cookie',
  'cookies',
  'otp',
  'pin',
  'ssn',
];
const PAIRS = [
  ['api', 'key'],
  ['private', 'key'],
  ['access', 'key'],
  ['secret', 'key'],
  ['session', 'id'],
  ['session', 'key'],
  ['client', 'secret'],
];
const WHOLE = ['auth', 'authorization', 'session', 'bearer', 'signature'];

export function isSensitiveKey(key: string): boolean {
  if (key.startsWith('__bugprint')) return true; // our own bookkeeping
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (!words.length) return false;
  if (WHOLE.includes(words.join(''))) return true;
  if (words.some((w) => WORDS.includes(w))) return true;
  return PAIRS.some(([a, b]) => words.some((w, i) => w === a && words[i + 1] === b));
}

const DEFAULT_KEYS = ['Enter', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Delete'];

interface NodeMirror {
  getId(n: Node): number;
}

type Emit = (payload: InteractionPayload) => void;

export function getRecordBugprintPlugin(options: BugprintRecordOptions = {}) {
  const keys = new Set(options.keys ?? DEFAULT_KEYS);
  const shortcuts = options.shortcuts ?? true;
  let mirror: NodeMirror | null = null;

  return {
    name: PLUGIN_NAME,
    options,
    getMirror(m: { nodeMirror: NodeMirror }) {
      mirror = m.nodeMirror;
    },
    observer(cb: (...args: unknown[]) => void, win: Window) {
      const emit: Emit = (p) => cb(p);
      const teardowns: (() => void)[] = [];

      // ---- initial storage ------------------------------------------------
      if (options.storage ?? true) {
        const custom = options.sensitiveKeys;
        const max = options.maxValueLength ?? 20_000;
        const masked: string[] = [];
        const keep = (k: string, v: string) => {
          if (isSensitiveKey(k) || custom?.test(k)) masked.push(k);
          else if (v.length <= max) return true;
          return false;
        };
        const localStorage: Record<string, string> = {};
        try {
          for (let i = 0; i < win.localStorage.length; i++) {
            const k = win.localStorage.key(i);
            if (k === null) continue;
            const v = win.localStorage.getItem(k) ?? '';
            if (keep(k, v)) localStorage[k] = v;
          }
        } catch {
          /* storage blocked (privacy mode, sandboxed iframe) */
        }
        const cookies: Record<string, string> = {};
        for (const part of win.document.cookie ? win.document.cookie.split('; ') : []) {
          const eq = part.indexOf('=');
          const k = decodeURIComponent(eq === -1 ? part : part.slice(0, eq));
          const v = eq === -1 ? '' : part.slice(eq + 1);
          if (keep(k, v)) cookies[k] = v;
        }
        emit({ type: 'storage', origin: win.location.origin, localStorage, cookies, masked });
      }

      // ---- keys -----------------------------------------------------------
      const onKey = (e: KeyboardEvent) => {
        if (e.isComposing || e.key === 'Process') return; // IME composition (Korean, Japanese, ...)
        const mods = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Meta'].filter(Boolean) as string[];
        const isShortcut = shortcuts && (e.ctrlKey || e.metaKey || e.altKey) && !['Control', 'Meta', 'Alt', 'Shift'].includes(e.key);
        if (!keys.has(e.key) && !isShortcut) return;
        const key = [...mods, e.key].join('+'); // test-runner syntax, e.g. "Shift+Enter", "Control+k"
        const target = e.target && typeof (e.target as Node).nodeType === 'number' ? (e.target as Node) : null;
        const id = target && mirror ? mirror.getId(target) : null;
        emit({ type: 'key', key, id: id !== null && id >= 0 ? id : null });
      };
      win.addEventListener('keydown', onKey, true);
      teardowns.push(() => win.removeEventListener('keydown', onKey, true));

      // ---- client-side navigation -----------------------------------------
      const history = win.history;
      const entries = [win.location.href];
      let index = 0;
      const wrap = (method: 'pushState' | 'replaceState') => {
        const original = history[method];
        history[method] = function (this: History, ...args: Parameters<History['pushState']>) {
          const before = win.location.href;
          const result = original.apply(this, args);
          const href = win.location.href;
          if (method === 'pushState') {
            entries.splice(index + 1, entries.length, href);
            index = entries.length - 1;
          } else entries[index] = href;
          if (href !== before) emit({ type: 'nav', href, via: method === 'pushState' ? 'push' : 'replace' });
          return result;
        } as History['pushState'];
        teardowns.push(() => {
          history[method] = original;
        });
      };
      wrap('pushState');
      wrap('replaceState');

      const onPop = () => {
        const href = win.location.href;
        let via: 'back' | 'forward' | 'pop' = 'pop';
        if (entries[index - 1] === href) {
          via = 'back';
          index--;
        } else if (entries[index + 1] === href) {
          via = 'forward';
          index++;
        } else {
          // e.g. an in-page #anchor link: behaves like a push
          entries.splice(index + 1, entries.length, href);
          index = entries.length - 1;
        }
        emit({ type: 'nav', href, via });
      };
      win.addEventListener('popstate', onPop);
      teardowns.push(() => win.removeEventListener('popstate', onPop));

      return () => teardowns.forEach((t) => t());
    },
  };
}
