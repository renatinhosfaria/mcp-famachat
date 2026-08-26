/**
 * O gerador é a fonte de verdade das ferramentas `fc_*`: uma rota perdida some do
 * catálogo do agente, e uma rota inventada vira uma tool que sempre falha. As
 * fixtures reproduzem os dois estilos de registro do backend e as armadilhas
 * reais encontradas nele.
 */

import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildManifest, extractRouteParams } from '../scripts/generate-routes.js';

const FIXTURE_ROOT = resolve(import.meta.dirname, 'fixtures/backend');
const manifest = buildManifest(FIXTURE_ROOT);
const keys = manifest.routes.map((r) => `${r.method} ${r.route}`);

describe('extractRouteParams', () => {
  it('separa obrigatórios de opcionais', () => {
    expect(extractRouteParams('/api/x/:id/y/:outro?')).toEqual({
      required: ['id'],
      optional: ['outro'],
    });
  });

  it('trata o wildcard como parâmetro obrigatório', () => {
    expect(extractRouteParams('/api/storage/files/*')).toEqual({
      required: ['wildcard'],
      optional: [],
    });
  });

  it('devolve listas vazias em rota sem parâmetro', () => {
    expect(extractRouteParams('/api/clientes')).toEqual({ required: [], optional: [] });
  });
});

describe('buildManifest', () => {
  it('captura rotas declaradas com path absoluto em app.<método>', () => {
    expect(keys).toContain('GET /api/clientes');
    expect(keys).toContain('DELETE /api/clientes/notes/:noteId');
  });

  it('resolve o prefixo de routers montados em routes.ts', () => {
    expect(keys).toContain('GET /api/leads');
    expect(keys).toContain('GET /api/leads/:id');
    expect(keys).toContain('POST /api/leads/:id/convert');
  });

  it('resolve routers exportados por um index de módulo', () => {
    expect(keys).toContain('GET /api/appointments');
    expect(keys).toContain('PATCH /api/appointments/:id');
  });

  it('marca como alias a segunda montagem do mesmo router', () => {
    const principal = manifest.routes.find((r) => r.route === '/api/empreendimentos/:id');
    const alias = manifest.routes.find((r) => r.route === '/api/empreendimentos-page/:id');
    expect(principal?.alias).toBe(false);
    expect(alias?.alias).toBe(true);
    expect(manifest.counts.aliases).toBe(1);
  });

  it('ignora clientes HTTP que imitam a forma de uma rota', () => {
    expect(keys.some((key) => key.includes('/externo/coisa'))).toBe(false);
  });

  it('ignora arquivos de teste', () => {
    expect(keys.some((key) => key.includes('nao-deve-aparecer'))).toBe(false);
  });

  it('ignora arquivos de rota que ninguém importa', () => {
    expect(keys.some((key) => key.includes('/orfao'))).toBe(false);
  });

  it('resolve router montado sob prefixo dentro do próprio arquivo', () => {
    expect(keys).toContain('GET /api/og-image/:slug');
  });

  it('aceita parâmetro com tipo qualificado (express.Express)', () => {
    expect(keys).toContain('POST /api/uploads/imovel/:imovelId');
  });

  it('segue registro em cascata entre arquivos', () => {
    expect(keys).toContain('GET /api/webhooks/events');
  });

  it('preenche os parâmetros de cada rota', () => {
    const opcional = manifest.routes.find((r) => r.route === '/api/rate-limit/reset/:userId?');
    expect(opcional?.pathParams).toEqual([]);
    expect(opcional?.optionalParams).toEqual(['userId']);

    const wildcard = manifest.routes.find((r) => r.route === '/api/storage/files/*');
    expect(wildcard?.pathParams).toEqual(['wildcard']);
  });

  it('atribui o módulo a partir do caminho do arquivo', () => {
    expect(manifest.routes.find((r) => r.route === '/api/leads')?.module).toBe('leads');
    expect(manifest.routes.find((r) => r.route === '/api/appointments')?.module).toBe('agenda');
  });

  it('registra a origem de cada rota no código', () => {
    const rota = manifest.routes.find((r) => r.route === '/api/leads/:id');
    expect(rota?.sourceFile).toBe('server/routes/leads.ts');
    expect(rota?.sourceLine).toBeGreaterThan(0);
  });

  it('produz uma contagem coerente com as rotas listadas', () => {
    expect(manifest.counts.total).toBe(manifest.routes.length);
    expect(manifest.counts.unique).toBe(manifest.counts.total - manifest.counts.aliases);
  });

  it('não duplica pares método+rota', () => {
    expect(new Set(keys).size).toBe(keys.length);
  });
});
