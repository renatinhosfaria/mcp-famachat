/**
 * Nome de ferramenta MCP a partir de método + rota.
 *
 * O nome é a única coisa que o modelo vê ao escolher entre centenas de tools, então
 * precisa ser legível e — acima de tudo — estável: renomear uma ferramenta entre
 * deploys quebra qualquer `tools.include` configurado no lado do Hermes.
 */

export const TOOL_PREFIX = 'fc_';

/** Limite conservador; a maioria dos clientes MCP aceita 64+ caracteres. */
export const MAX_TOOL_NAME = 64;

const METHOD_ALIAS: Record<string, string> = {
  GET: 'get',
  POST: 'post',
  PUT: 'put',
  PATCH: 'patch',
  DELETE: 'del',
};

function sanitize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function slugSegment(segment: string): string {
  // `*` é o wildcard do Express (ex.: DELETE /api/storage/files/*).
  if (segment === '*') return 'wildcard';
  // `:nome` e `:nome?` (parâmetro opcional) — o `?` não pode vazar para o nome.
  if (segment.startsWith(':')) return `by_${sanitize(segment.slice(1))}`;
  return sanitize(segment);
}

/** `GET /api/clientes/:id/notes` → `fc_get_clientes_by_id_notes` */
export function baseToolName(method: string, route: string): string {
  const verb = METHOD_ALIAS[method.toUpperCase()] ?? method.toLowerCase();
  const segments = route
    .replace(/^\/api\/?/, '')
    .split('/')
    .map(slugSegment)
    .filter(Boolean);

  const name = `${TOOL_PREFIX}${[verb, ...segments].join('_')}`;
  return name.replace(/_{2,}/g, '_').replace(/_+$/, '');
}

/**
 * Encurta pelo meio, preservando o começo (verbo + recurso) e o fim (o que
 * distingue rotas irmãs). Só entra em ação em rotas muito longas.
 */
function shorten(name: string): string {
  if (name.length <= MAX_TOOL_NAME) return name;
  const head = name.slice(0, MAX_TOOL_NAME - 21);
  const tail = name.slice(-20);
  return `${head}_${tail}`.replace(/_{2,}/g, '_');
}

export type NameableRoute = { method: string; route: string };

/**
 * Atribui nomes únicos ao conjunto inteiro. A ordenação por método+rota torna o
 * resultado determinístico: as mesmas rotas produzem sempre os mesmos nomes,
 * independentemente da ordem em que o manifesto foi gerado.
 */
export function assignToolNames<T extends NameableRoute>(routes: readonly T[]): Map<T, string> {
  const ordered = [...routes].sort(
    (a, b) => a.route.localeCompare(b.route) || a.method.localeCompare(b.method)
  );

  const used = new Set<string>();
  const assigned = new Map<T, string>();

  for (const entry of ordered) {
    const base = shorten(baseToolName(entry.method, entry.route));
    let name = base;
    let suffix = 2;
    while (used.has(name)) {
      const marker = `_${suffix}`;
      name = `${base.slice(0, MAX_TOOL_NAME - marker.length)}${marker}`;
      suffix += 1;
    }
    used.add(name);
    assigned.set(entry, name);
  }

  return assigned;
}
