import { rewriteJsonStrings } from './json-rewrite.js';

/**
 * Secret detection for recorded data that ends up in a test file (and usually
 * in a git repository): API responses, storage values, typed values.
 *
 * Keys are judged by the *words* they are made of, so `accessToken`,
 * `refresh_token`, `X-Api-Key` and `sessionId` are caught while `author` or
 * `tokenizer` (a different word) are not.
 * Keep in sync with isSensitiveKey() in src/recorder/plugin.ts (tested).
 */
const WORDS = new Set([
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
  'otp',
  'pin',
  'ssn',
]);
const PAIRS = [
  ['api', 'key'],
  ['private', 'key'],
  ['access', 'key'],
  ['secret', 'key'],
  ['session', 'id'],
  ['session', 'key'],
  ['client', 'secret'],
];
const WHOLE = new Set(['auth', 'authorization', 'session', 'bearer', 'signature']);

export function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function isSensitiveKey(key: string): boolean {
  const words = keyWords(key);
  if (!words.length) return false;
  if (WHOLE.has(words.join(''))) return true;
  if (words.some((w) => WORDS.has(w))) return true;
  return PAIRS.some(([a, b]) => words.some((w, i) => w === a && words[i + 1] === b));
}

const PATTERNS: [RegExp, string][] = [
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, 'eyJredacted.eyJredacted.redacted'], // JWT
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, '$1 redacted'],
  [/\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{8,}/g, '$1_$2_redacted'], // payment-provider style keys
  [/\b(ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{16,}/g, '$1_redacted'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, 'xox-redacted'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AKIAREDACTEDREDACTED'],
];

/** Replaces well-known token formats anywhere in a string. */
export function redactSecretText(s: string): string {
  return PATTERNS.reduce((acc, [re, to]) => acc.replace(re, to), s);
}

export interface SecretRedaction {
  value: string;
  count: number;
}

/**
 * JSON bodies: string values under sensitive keys become "redacted" (numbers and
 * booleans are kept so the app's logic still works); every other string is scanned
 * for token formats. Non-JSON bodies only get the format scan.
 */
export function redactSecrets(body: string, contentType: string | null = null): SecretRedaction {
  let count = 0;
  const text = (v: string) => {
    const r = redactSecretText(v);
    if (r !== v) count++;
    return r;
  };
  const looksJson = contentType?.includes('json') || /^\s*[[{]/.test(body);
  if (looksJson) {
    // Rewrites only the affected strings; everything else (numbers, spacing) stays byte-identical.
    const out = rewriteJsonStrings(body, (v, keys) => {
      if (v && keys.some(isSensitiveKey)) {
        count++;
        return 'redacted';
      }
      return text(v);
    });
    if (out !== null) return { value: out, count };
  }
  return { value: text(body), count };
}
