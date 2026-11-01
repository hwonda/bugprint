import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { EventType, type RrwebEvent } from './types.js';

export interface Session {
  id: string;
  source: string;
  events: RrwebEvent[];
  startedAt: number;
  durationMs: number;
}

const isEvent = (e: unknown): e is RrwebEvent =>
  Boolean(e) && typeof e === 'object' && typeof (e as RrwebEvent).type === 'number' && typeof (e as RrwebEvent).timestamp === 'number';

/**
 * Finds the rrweb events inside whatever a recording was exported as:
 *  - a bare array of events, or an array of segments (arrays of events)
 *  - an object holding them under any key, at any depth up to 4
 *    (`{ events }`, `{ snapshots }`, `{ data: { snapshots } }`, `{ recording: { segments } }`, ...)
 *  - newline-delimited JSON (one event, or one segment, per line)
 * Events from all segments are merged and sorted by time.
 */
function collectEvents(value: unknown, depth = 0): RrwebEvent[] {
  if (depth > 4 || value === null || typeof value !== 'object') return [];
  if (Array.isArray(value)) {
    const direct = value.filter(isEvent);
    if (direct.length) return direct;
    return value.flatMap((v) => (Array.isArray(v) || (v && typeof v === 'object') ? collectEvents(v, depth + 1) : []));
  }
  // Prefer the property holding the most events (ignores small metadata arrays).
  let best: RrwebEvent[] = [];
  for (const v of Object.values(value)) {
    const found = collectEvents(v, depth + 1);
    if (found.length > best.length) best = found;
  }
  return best;
}

export function parseEvents(raw: unknown): RrwebEvent[] {
  let value = raw;
  if (typeof value === 'string') {
    const text = value.trim();
    try {
      value = JSON.parse(text);
    } catch {
      value = text
        .split('\n')
        .filter((l) => l.trim())
        .map((l, i) => {
          try {
            return JSON.parse(l);
          } catch {
            throw new Error(`Recording is not valid JSON or NDJSON (line ${i + 1}).`);
          }
        });
    }
  }
  if (!value || typeof value !== 'object') throw new Error('Recording must be JSON containing rrweb events.');
  const events = collectEvents(value);
  if (!events.length) throw new Error('No rrweb events found in the recording (expected objects with numeric "type" and "timestamp").');
  if (!events.some((e) => e.type === EventType.FullSnapshot)) {
    throw new Error('Recording has no full DOM snapshot (event type 2); it cannot be mapped to elements.');
  }
  // De-duplicate events repeated across overlapping segments, then order by time.
  const seen = new Set<string>();
  const unique = events.filter((e) => {
    const key = `${e.timestamp}:${e.type}:${JSON.stringify(e.data)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique.sort((a, b) => a.timestamp - b.timestamp);
}

export function createSession(events: RrwebEvent[], source: string): Session {
  const hash = createHash('sha1')
    .update(String(events.length))
    .update(String(events[0]!.timestamp))
    .update(String(events.at(-1)!.timestamp))
    .update(source)
    .digest('hex')
    .slice(0, 8);
  return {
    id: `ses_${hash}`,
    source,
    events,
    startedAt: events[0]!.timestamp,
    durationMs: events.at(-1)!.timestamp - events[0]!.timestamp,
  };
}

export async function loadSessionFile(path: string): Promise<Session> {
  const text = await readFile(path, 'utf8');
  return createSession(parseEvents(text), path);
}
