/**
 * `fc_catalog` — navegação pelas centenas de ferramentas `fc_*`.
 *
 * Com todos os endpoints do backend expostos individualmente, o agente precisa de
 * um índice: procurar "cliente" e receber os nomes exatos das tools é mais
 * confiável do que tentar adivinhar como uma rota foi nomeada.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { BackendRoute, RouteManifest } from '../famachat/manifest.js';

const MAX_RESULTS = 120;

/**
 * O agente conversa em português, mas boa parte das rotas está em inglês —
 * procurar "agendamento" não acha `/api/appointments`. Cada termo em português
 * expande para os fragmentos que aparecem de fato nas rotas.
 */
const SINONIMOS: Record<string, string[]> = {
  agendamento: ['appointment', 'agenda'],
  agenda: ['appointment', 'agenda'],
  compromisso: ['appointment'],
  visita: ['visit'],
  venda: ['sale'],
  vendas: ['sale'],
  usuario: ['user'],
  usuarios: ['user'],
  corretor: ['user', 'broker', 'corretor'],
  arquivo: ['arquivo', 'file', 'upload', 'storage'],
  imovel: ['imovei', 'imovel', 'casa', 'apartamento', 'terreno', 'empreendimento'],
  imoveis: ['imovei', 'casa', 'apartamento', 'terreno', 'empreendimento'],
  propriedade: ['imovei', 'casa', 'apartamento', 'terreno'],
  proprietario: ['proprietario'],
  lead: ['lead'],
  cliente: ['cliente'],
  painel: ['dashboard'],
  metrica: ['metric', 'dashboard'],
  relatorio: ['dashboard', 'metric'],
  autenticacao: ['auth'],
  login: ['auth'],
  mensagem: ['whatsapp'],
  zap: ['whatsapp'],
  horario: ['horario'],
  endereco: ['endereco'],
  construtora: ['construtora'],
  automacao: ['automation', 'sla'],
};

/** Remove acentos para casar "imóvel" com "imovel". */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function searchTerms(term: string): string[] {
  const base = normalize(term.trim());
  const expanded = new Set([base]);
  for (const word of base.split(/\s+/).filter(Boolean)) {
    expanded.add(word);
    for (const synonym of SINONIMOS[word] ?? []) expanded.add(synonym);
    // Plural simples: "clientes" → "cliente".
    if (word.endsWith('s')) {
      const singular = word.slice(0, -1);
      expanded.add(singular);
      for (const synonym of SINONIMOS[singular] ?? []) expanded.add(synonym);
    }
  }
  return [...expanded].filter(Boolean);
}

type Entry = { name: string; route: BackendRoute };

function matches(entry: Entry, term: string): boolean {
  const haystack = normalize(
    `${entry.name} ${entry.route.method} ${entry.route.route} ${entry.route.module}`
  );
  return searchTerms(term).some((needle) => haystack.includes(needle));
}

export function registerCatalogTool(
  server: McpServer,
  manifest: RouteManifest,
  names: Map<BackendRoute, string>
): void {
  const entries: Entry[] = [...names].map(([route, name]) => ({ name, route }));
  const modules = [...new Set(entries.map((e) => e.route.module))].sort();

  server.registerTool(
    'fc_catalog',
    {
      title: 'Catálogo de endpoints do FamaChat',
      description:
        'Lista as ferramentas fc_* disponíveis, com o método e a rota de cada uma. ' +
        'Use antes de chamar um endpoint para descobrir o nome exato da ferramenta. ' +
        `Sem argumentos, devolve os ${modules.length} módulos e a contagem de rotas de cada um.`,
      inputSchema: {
        modulo: z
          .string()
          .optional()
          .describe(`Filtra por módulo. Valores possíveis: ${modules.join(', ')}`),
        busca: z
          .string()
          .optional()
          .describe(
            'Texto livre buscado no nome da ferramenta, na rota e no módulo. ' +
              'Entende português e acentos: "agendamento" encontra /api/appointments.'
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ modulo, busca }) => {
      if (!modulo && !busca) {
        const counts = new Map<string, number>();
        for (const entry of entries) {
          counts.set(entry.route.module, (counts.get(entry.route.module) ?? 0) + 1);
        }
        const lines = [...counts.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([mod, count]) => `  ${String(count).padStart(3)}  ${mod}`);

        return {
          content: [
            {
              type: 'text' as const,
              text: [
                `${entries.length} endpoints do FamaChat em ${counts.size} módulos`,
                `(backend no commit ${manifest.sourceCommit}, manifesto de ${manifest.generatedAt}).`,
                '',
                'Rotas por módulo:',
                ...lines,
                '',
                'Chame fc_catalog com { modulo: "clientes" } ou { busca: "agendamento" }.',
              ].join('\n'),
            },
          ],
        };
      }

      let found = entries;
      if (modulo) found = found.filter((e) => e.route.module === modulo);
      if (busca) found = found.filter((e) => matches(e, busca));

      if (found.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Nada encontrado. Módulos disponíveis: ${modules.join(', ')}`,
            },
          ],
        };
      }

      const shown = found.slice(0, MAX_RESULTS);
      const lines = shown
        .sort((a, b) => a.route.route.localeCompare(b.route.route))
        .map((e) => `  ${e.route.method.padEnd(6)} ${e.route.route}  →  ${e.name}`);

      const overflow =
        found.length > shown.length
          ? [`\n… e mais ${found.length - shown.length}. Refine com "modulo" ou "busca".`]
          : [];

      return {
        content: [
          {
            type: 'text' as const,
            text: [`${found.length} endpoint(s):`, ...lines, ...overflow].join('\n'),
          },
        ],
      };
    }
  );
}
