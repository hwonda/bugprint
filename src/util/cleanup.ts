import type { ChildProcess } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

/**
 * bugprint writes a few temporary files inside the user's project (the runner
 * wrapper config must sit next to their config; minimize candidates must be able
 * to import the test runner). These helpers make sure they disappear even when
 * the process is interrupted, and sweep leftovers from processes that were killed.
 */

const paths = new Set<string>();
const children = new Set<ChildProcess>();
let installed = false;

function sweep() {
  for (const c of children) {
    try {
      c.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
  children.clear();
  for (const p of paths) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  paths.clear();
}

function install() {
  if (installed) return;
  installed = true;
  process.on('exit', sweep);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.once(sig, () => {
      sweep();
      process.kill(process.pid, sig); // re-raise with the default handler
    });
  }
}

/** Removes `p` on exit or interruption unless the returned release() is called first. */
export function trackPath(p: string): () => void {
  install();
  paths.add(p);
  return () => paths.delete(p);
}

export function trackChild(c: ChildProcess): () => void {
  install();
  children.add(c);
  return () => children.delete(c);
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Temp names embed the owning pid: `<prefix><pid>-...`. Deletes entries whose process is gone. */
export function sweepStale(dir: string, prefix: string): string[] {
  const removed: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return removed;
  }
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue;
    const pid = Number(/^(\d+)-/.exec(name.slice(prefix.length))?.[1]);
    if (!pid || pid === process.pid || isAlive(pid)) continue;
    try {
      rmSync(path.join(dir, name), { recursive: true, force: true });
      removed.push(name);
    } catch {
      /* ignore */
    }
  }
  return removed;
}
