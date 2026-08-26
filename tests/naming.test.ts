import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assignToolNames, baseToolName, MAX_TOOL_NAME } from '../src/tools/naming.js';

const manifest = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../routes/backend-routes.json'), 'utf8')
) as { routes: { method: string; route: string }[] };

describe('baseToolName', () => {
  it('deriva o nome do método e da rota', () => {
    expect(baseToolName('GET', '/api/clientes')).toBe('fc_get_clientes');
    expect(baseToolName('POST', '/api/clientes')).toBe('fc_post_clientes');
  });

  it('transforma parâmetros de rota em by_<nome>', () => {
    expect(baseToolName('GET', '/api/clientes/:id/notes')).toBe('fc_get_clientes_by_id_notes');
    expect(baseToolName('DELETE', '/api/clientes/notes/:noteId')).toBe(
      'fc_del_clientes_notes_by_noteid'
    );
  });

  it('normaliza hífens e segmentos com números', () => {
    expect(baseToolName('GET', '/api/dashboard/gestor/indices-ultimos-12-meses')).toBe(
      'fc_get_dashboard_gestor_indices_ultimos_12_meses'
    );
  });

  it('distingue métodos diferentes na mesma rota', () => {
    expect(baseToolName('PUT', '/api/clientes/:id')).not.toBe(baseToolName('PATCH', '/api/clientes/:id'));
  });
});

describe('assignToolNames sobre o manifesto real', () => {
  const names = assignToolNames(manifest.routes);

  it('nomeia todas as rotas', () => {
    expect(names.size).toBe(manifest.routes.length);
  });

  it('não produz colisões', () => {
    expect(new Set(names.values()).size).toBe(names.size);
  });

  it('respeita o limite de tamanho e o formato aceito pelo MCP', () => {
    for (const name of names.values()) {
      expect(name.length).toBeLessThanOrEqual(MAX_TOOL_NAME);
      expect(name).toMatch(/^[a-z0-9_]+$/);
    }
  });

  it('é determinístico — a ordem de entrada não altera o resultado', () => {
    const shuffled = [...manifest.routes].reverse();
    const other = assignToolNames(shuffled);
    for (const [route, name] of names) {
      const twin = [...other].find(
        ([r]) => r.method === route.method && r.route === route.route
      );
      expect(twin?.[1]).toBe(name);
    }
  });
});
