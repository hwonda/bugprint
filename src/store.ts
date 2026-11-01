import path from 'node:path';
import { extractFlow, type ExtractOptions, type Flow } from './flow/extract.js';
import { createSession, loadSessionFile, parseEvents, type Session } from './session/load.js';

/** In-memory registry so an agent can load a recording once and query it many times. */
export class SessionStore {
  private sessions = new Map<string, Session>();
  private flows = new Map<string, Flow>();

  async loadFromPath(p: string, cwd = process.cwd()): Promise<Session> {
    const abs = path.resolve(cwd, p);
    return this.add(await loadSessionFile(abs));
  }

  loadFromData(data: unknown, label = 'inline'): Session {
    return this.add(createSession(parseEvents(data), label));
  }

  private add(s: Session): Session {
    this.sessions.set(s.id, s);
    for (const k of [...this.flows.keys()]) if (k.startsWith(`${s.id}:`)) this.flows.delete(k);
    return s;
  }

  get(id: string): Session {
    const s = this.sessions.get(id);
    if (!s) {
      const known = [...this.sessions.keys()];
      throw new Error(`Unknown sessionId "${id}". ${known.length ? `Loaded: ${known.join(', ')}` : 'Call load_session first.'}`);
    }
    return s;
  }

  flow(id: string, opts: ExtractOptions = {}): Flow {
    const key = `${id}:${opts.fromMs ?? ''}:${opts.toMs ?? ''}`;
    let f = this.flows.get(key);
    if (!f) {
      f = extractFlow(this.get(id), opts);
      this.flows.set(key, f);
    }
    return f;
  }

  list(): Session[] {
    return [...this.sessions.values()];
  }
}
