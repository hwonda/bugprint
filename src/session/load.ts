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

/**
 * Accepts the common shapes a recording is exported in:
 *  - a bare array of rrweb events
 *  - `{ events: [...] }`
 *  - newline-delimited JSON (one event per line)
 */
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
  if (value && typeof value === 'object' && !Array.isArray(value) && Array.isArray((value as { events?: unknown }).events)) {
    value = (value as { events: unknown[] }).events;
  }
  if (!Array.isArray(value)) throw new Error('Recording must be an array of rrweb events or an object with an "events" array.');

  const events = value.filter(
    (e): e is RrwebEvent => e && typeof e === 'object' && typeof e.type === 'number' && typeof e.timestamp === 'number',
  );
  if (!events.length) throw new Error('Recording contains no rrweb events.');
  if (!events.some((e) => e.type === EventType.FullSnapshot)) {
    throw new Error('Recording has no full DOM snapshot (event type 2); it cannot be mapped to elements.');
  }
  return [...events].sort((a, b) => a.timestamp - b.timestamp);
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
