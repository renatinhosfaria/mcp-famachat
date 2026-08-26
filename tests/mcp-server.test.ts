/**
 * Handshake MCP in-process: sobe o servidor real contra um cliente real do SDK,
 * ligados por um transporte em memória. Cobre o que o Hermes faz no boot —
 * initialize e tools/list — e uma chamada de ferramenta de ponta a ponta.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Logger } from '../src/audit/logger.js';
import type { Database } from '../src/db/pool.js';
import { FamachatClient } from '../src/famachat/client.js';
import type { RouteManifest } from '../src/famachat/manifest.js';
import { countTools, createMcpServer, SERVER_INFO } from '../src/mcp/server.js';

const manifest = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../routes/backend-routes.json'), 'utf8')
) as RouteManifest;

const AUDIT_PATH = resolve(import.meta.dirname, '../logs/test-audit.jsonl');

function fakeJwt(): string {
  const payload = Buffer.from(
    JSON.stringify({ id: 1, exp: Math.floor(Date.now() / 1000) + 3600 })
  ).toString('base64url');
  return `header.${payload}.signature`;
}

/** Backend simulado: responde ao login e devolve um eco do que foi chamado. */
function fakeBackend() {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    if (href.endsWith('/api/auth/login')) {
      return new Response(JSON.stringify({ accessToken: fakeJwt() }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ chamado: href, metodo: init?.method }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

const fetchMock = fakeBackend();

const db = {
  query: vi.fn(async () => ({
    command: 'SELECT',
    rowCount: 1,
    rows: [{ total: 7 }],
    fields: [{ name: 'total', dataTypeId: 20 }],
    truncated: false,
    durationMs: 3,
  })),
} as unknown as Database;

async function connectClient(): Promise<Client> {
  const logger = new Logger(AUDIT_PATH, 'error');
  const famachat = new FamachatClient(
    {
      FAMACHAT_API_URL: 'http://backend.test',
      FAMACHAT_SERVICE_EMAIL: 'hermes-agent@famachat.com.br',
      FAMACHAT_SERVICE_PASSWORD: 'senha',
      FAMACHAT_REQUEST_TIMEOUT_MS: 5000,
      FAMACHAT_MAX_RESPONSE_BYTES: 1_048_576,
    },
    fetchMock as unknown as typeof fetch
  );

  const server = createMcpServer({ manifest, client: famachat, db, logger });
  const client = new Client({ name: 'teste', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('handshake MCP', () => {
  let client: Client;
  let toolNames: string[];

  beforeAll(async () => {
    client = await connectClient();
    const { tools } = await client.listTools();
    toolNames = tools.map((tool) => tool.name);
  });

  it('anuncia a identidade do servidor no initialize', () => {
    expect(client.getServerVersion()).toMatchObject({ name: SERVER_INFO.name });
  });

  it('expõe uma ferramenta por endpoint, mais o catálogo e as de banco', () => {
    expect(toolNames).toHaveLength(countTools(manifest));
    expect(toolNames).toContain('fc_catalog');
    expect(toolNames).toContain('db_query');
    expect(toolNames).toContain('db_describe_table');
  });

  it('não repete nomes de ferramenta', () => {
    expect(new Set(toolNames).size).toBe(toolNames.length);
  });

  it('descreve o schema de entrada de uma rota com parâmetro', async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'fc_get_clientes_by_id');
    expect(tool).toBeDefined();
    expect(tool?.inputSchema.properties).toHaveProperty('id');
    expect(tool?.inputSchema.properties).toHaveProperty('query');
  });

  it('não oferece corpo em ferramentas GET', async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'fc_get_clientes');
    expect(tool?.inputSchema.properties).not.toHaveProperty('body');
  });

  it('oferece corpo em ferramentas POST', async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'fc_post_clientes');
    expect(tool?.inputSchema.properties).toHaveProperty('body');
  });

  it('chama o backend ao executar uma ferramenta fc_*', async () => {
    const result = await client.callTool({
      name: 'fc_get_clientes_by_id',
      arguments: { id: 42 },
    });

    const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(text).toContain('/api/clientes/42');
    expect(result.isError).toBeFalsy();
  });

  it('executa uma consulta pela ferramenta db_query', async () => {
    const result = await client.callTool({
      name: 'db_query',
      arguments: { sql: 'SELECT count(*) AS total FROM clientes' },
    });

    const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(text).toContain('"total": 7');
  });

  it('lista os módulos no fc_catalog sem argumentos', async () => {
    const result = await client.callTool({ name: 'fc_catalog', arguments: {} });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(text).toContain('endpoints do FamaChat');
    expect(text).toContain('clientes');
  });

  it('filtra o catálogo por busca em português, mesmo com a rota em inglês', async () => {
    const result = await client.callTool({ name: 'fc_catalog', arguments: { busca: 'agendamento' } });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(text).not.toContain('Nada encontrado');
    expect(text).toContain('/api/appointments');
  });

  it('entende acentos e plural na busca', async () => {
    const result = await client.callTool({ name: 'fc_catalog', arguments: { busca: 'imóveis' } });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(text).not.toContain('Nada encontrado');
  });

  it('avisa quando a busca não encontra nada', async () => {
    const result = await client.callTool({
      name: 'fc_catalog',
      arguments: { busca: 'zzz-inexistente-zzz' },
    });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(text).toContain('Nada encontrado');
  });

  it('filtra o catálogo por módulo', async () => {
    const result = await client.callTool({ name: 'fc_catalog', arguments: { modulo: 'clientes' } });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(text).toContain('/api/clientes');
    expect(text).toContain('fc_get_clientes');
  });
});
