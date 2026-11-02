import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** `checkout.spec.ts` → `checkout.responses.json` (also `repro.ts`, `x.test.mjs`, ...). */
export function fixturesName(testFile: string): string {
  const base = path
    .basename(testFile)
    .replace(/\.(spec|test)\.[cm]?[jt]sx?$/, '')
    .replace(/\.[cm]?[jt]sx?$/, '');
  return `${base}.responses.json`;
}

/** Writes a generated test and its sidecar files (recorded response fixtures) next to it. */
export async function writeOutputs(file: string, result: { code: string; files: { name: string; content: string }[] }): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, result.code, 'utf8');
  for (const f of result.files) await writeFile(path.join(path.dirname(file), f.name), f.content, 'utf8');
}
