/**
 * Montagem do McpServer: registra as ferramentas de endpoint e as de banco.
 *
 * Em modo stateless uma instância é criada por requisição, então esta função
 * precisa ser barata — o manifesto e as conexões vêm prontos de fora.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from '../audit/logger.js';
import type { Database } from '../db/pool.js';
import type { FamachatClient } from '../famachat/client.js';
import type { RouteManifest } from '../famachat/manifest.js';
import { registerApiTools } from '../tools/api-tools.js';
import { registerCatalogTool } from '../tools/catalog-tool.js';
import { registerDbTools } from '../tools/db-tools.js';

export const SERVER_INFO = { name: 'famachat', version: '1.0.0' } as const;

const INSTRUCTIONS = `Este servidor dá acesso ao FamaChat, o CRM imobiliário da Fama Negócios Imobiliários.

Duas famílias de ferramentas:

• fc_* — um endpoint HTTP do backend cada. Passam pelas regras de negócio do
  sistema (rotação de leads por SLA Cascata, eventos de Meta CAPI, webhooks de
  saída). São o caminho preferido para criar e alterar dados.
  Comece por fc_catalog para localizar a ferramenta certa.

• db_* — acesso direto ao PostgreSQL de produção. Ideal para consultas, relatórios
  e correções em massa que nenhum endpoint cobre. Escritas aqui NÃO disparam as
  regras de negócio do backend. db_query aceita DDL: confirme com o usuário antes
  de qualquer CREATE, ALTER, DROP ou TRUNCATE.

Toda chamada é auditada.`;

export type ServerDeps = {
  manifest: RouteManifest;
  client: FamachatClient;
  db: Database;
  logger: Logger;
};

export function createMcpServer({ manifest, client, db, logger }: ServerDeps): McpServer {
  const server = new McpServer(SERVER_INFO, {
    capabilities: { tools: {} },
    instructions: INSTRUCTIONS,
  });

  const names = registerApiTools(server, manifest, client, logger);
  registerCatalogTool(server, manifest, names);
  registerDbTools(server, db, logger);

  return server;
}

/** Quantidade de ferramentas expostas — usada no log de partida e no /health. */
export function countTools(manifest: RouteManifest): number {
  const DB_TOOLS = 5;
  const CATALOG_TOOLS = 1;
  return manifest.routes.length + DB_TOOLS + CATALOG_TOOLS;
}
