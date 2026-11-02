/**
 * Rewrites string *values* inside a JSON text while copying every other byte verbatim.
 *
 * JSON.parse + JSON.stringify would silently change data: 64-bit ids lose precision
 * (1234567890123456789 → 1234567890123456800), `1.50` becomes `1.5`, and spacing and
 * key order details can change. A replayed app must see the bytes the user saw, so we
 * only touch the strings we are asked to rewrite.
 *
 * `fn(value, keys)` receives the decoded string and the object keys on its path
 * (array indices are skipped); return the replacement or the same value.
 * Returns null when the text is not valid JSON, so callers can fall back.
 */
export function rewriteJsonStrings(text: string, fn: (value: string, keys: string[]) => string): string | null {
  let i = 0;
  let out = '';
  let changed = false;
  const keys: string[] = [];

  const ws = () => {
    const start = i;
    while (i < text.length && ' \t\n\r'.includes(text[i]!)) i++;
    out += text.slice(start, i);
  };
  const readString = (): { raw: string; value: string } | null => {
    if (text[i] !== '"') return null;
    const start = i++;
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    if (i >= text.length) return null;
    i++;
    const raw = text.slice(start, i);
    try {
      return { raw, value: JSON.parse(raw) as string };
    } catch {
      return null;
    }
  };

  const value = (): boolean => {
    ws();
    const c = text[i];
    if (c === '{') {
      out += '{';
      i++;
      ws();
      if (text[i] === '}') {
        out += '}';
        i++;
        return true;
      }
      for (;;) {
        ws();
        const k = readString();
        if (!k) return false;
        out += k.raw;
        ws();
        if (text[i] !== ':') return false;
        out += ':';
        i++;
        keys.push(k.value);
        const ok = value();
        keys.pop();
        if (!ok) return false;
        ws();
        if (text[i] === ',') {
          out += ',';
          i++;
          continue;
        }
        if (text[i] === '}') {
          out += '}';
          i++;
          return true;
        }
        return false;
      }
    }
    if (c === '[') {
      out += '[';
      i++;
      ws();
      if (text[i] === ']') {
        out += ']';
        i++;
        return true;
      }
      for (;;) {
        if (!value()) return false;
        ws();
        if (text[i] === ',') {
          out += ',';
          i++;
          continue;
        }
        if (text[i] === ']') {
          out += ']';
          i++;
          return true;
        }
        return false;
      }
    }
    if (c === '"') {
      const s = readString();
      if (!s) return false;
      const next = fn(s.value, keys);
      if (next !== s.value) {
        changed = true;
        out += JSON.stringify(next);
      } else out += s.raw;
      return true;
    }
    // number, true, false, null: copy the literal as-is
    const m = /^(-?\d+(\.\d+)?([eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 400));
    if (!m) return false;
    out += m[0];
    i += m[0].length;
    return true;
  };

  if (!value()) return null;
  ws();
  if (i !== text.length) return null;
  return changed ? out : text;
}
