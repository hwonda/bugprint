import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createServer } from '../src/server.js';

const fixture = path.resolve(__dirname, '../fixtures/checkout-bug.json');

async function connect() {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    if (res.isError) throw new Error(res.content[0]!.text);
    return res.content[0]!.text;
  };
  return { client, call };
}

describe('MCP server (real recording)', () => {
  it('exposes the tools and the reproduce_bug prompt', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['extract_flow', 'generate_test', 'list_sessions', 'load_session', 'run_and_verify', 'summarize_session']);
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(['reproduce_bug']);
  });

  it('load → summarize → generate on a real rrweb session', async () => {
    const { call } = await connect();
    const loaded = JSON.parse(await call('load_session', { path: fixture }));
    expect(loaded.pages).toEqual(['/', '/?q=mouse', '/checkout.html']);
    expect(loaded.recorded).toEqual({ console: true, network: true, interaction: true });
    expect(loaded.errors[0].message).toMatch(/reading 'rate'/);

    const summary = await call('summarize_session', { sessionId: loaded.sessionId });
    expect(summary).toContain('click button "Add to cart" in listitem "Mechanical Keyboard"');
    expect(summary).toContain('press Enter in field labelled "Search products"');
    expect(summary).toContain('type "save20" into field labelled "Coupon code"');

    const dir = await mkdtemp(path.join(os.tmpdir(), 'bugprint-'));
    const out = path.join(dir, 'repro.spec.ts');
    await call('generate_test', { sessionId: loaded.sessionId, outputPath: out, baseUrl: 'http://localhost:4173' });
    const code = await readFile(out, 'utf8');
    expect(code).toContain("await page.getByTestId('place-order').click();");
    expect(code).toContain("getByLabel('Email').fill('user@example.com'); // redacted");
    expect(code).toContain('"url":"/api/coupons/save20"');
    expect(code).toContain('await page.clock.install(');
    await expect(call('generate_test', { sessionId: loaded.sessionId, outputPath: out })).rejects.toThrow(/already exists/);
  });

  it('reports unknown sessions helpfully', async () => {
    const { call } = await connect();
    await expect(call('summarize_session', { sessionId: 'nope' })).rejects.toThrow(/load_session/);
  });
});
