/**
 * Ferramentas de acesso direto ao PostgreSQL de produção.
 *
 * Por decisão explícita do dono do sistema, `db_query` aceita SQL irrestrito —
 * dados e estrutura, DDL incluído. Não há allowlist de comandos aqui: a trava
 * pedida foi nenhuma. O que existe é trilha: toda chamada é auditada em disco
 * antes de tocar o banco, e o `application_name=mcp-hermes` marca as sessões do
 * agente no `pg_stat_activity`.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Logger } from '../audit/logger.js';
import type { Database } from '../db/pool.js';

/** Comandos cujo efeito é irreversível sem restaurar backup. */
const DESTRUCTIVE = /^\s*(drop|truncate|alter\s+table\s+\S+\s+drop)\b/i;

function formatOutcome(outcome: {
  command: string;
  rowCount: number | null;
  rows: unknown[];
  truncated: boolean;
  durationMs: number;
}): string {
  const header = [
    `comando: ${outcome.command}`,
    `linhas afetadas/retornadas: ${outcome.rowCount ?? 0}`,
    `duração: ${outcome.durationMs}ms`,
  ];
  if (outcome.truncated) {
    header.push(`⚠ resultado truncado — mostrando ${outcome.rows.length} linhas`);
  }
  const body = outcome.rows.length > 0 ? JSON.stringify(outcome.rows, null, 2) : '(sem linhas)';
  return `${header.join(' | ')}\n\n${body}`;
}

/** Envolve um handler com auditoria e tradução de erro do Postgres. */
function audited(
  logger: Logger,
  tool: string,
  run: (args: Record<string, unknown>) => Promise<{ text: string; rowCount?: number; sql?: string }>
) {
  return async (args: Record<string, unknown>) => {
    const started = Date.now();
    try {
      const result = await run(args ?? {});
      logger.audit({
        tool,
        args,
        target: result.sql,
        status: 'ok',
        rowCount: result.rowCount,
        durationMs: Date.now() - started,
      });
      return { content: [{ type: 'text' as const, text: result.text }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.audit({
        tool,
        args,
        status: 'error',
        durationMs: Date.now() - started,
        error: message,
      });
      return {
        content: [{ type: 'text' as const, text: `Erro do PostgreSQL: ${message}` }],
        isError: true,
      };
    }
  };
}

export function registerDbTools(server: McpServer, db: Database, logger: Logger): void {
  server.registerTool(
    'db_query',
    {
      title: 'Executar SQL no PostgreSQL do FamaChat',
      description:
        'Executa SQL arbitrário no banco de produção (database neondb). Aceita SELECT, ' +
        'INSERT, UPDATE, DELETE e também DDL (CREATE, ALTER, DROP, TRUNCATE). ' +
        'Prefira parâmetros $1, $2 em vez de interpolar valores no texto. ' +
        'Comandos de DDL alteram a estrutura de que o FamaChat depende para funcionar — ' +
        'confirme com o usuário antes de executá-los.',
      inputSchema: {
        sql: z.string().min(1).describe('Instrução SQL a executar'),
        params: z
          .array(z.unknown())
          .optional()
          .describe('Valores para os placeholders $1, $2, … da instrução'),
        max_rows: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Máximo de linhas a retornar (padrão: DB_MAX_ROWS do servidor)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    audited(logger, 'db_query', async (args) => {
      const sql = args.sql as string;
      const params = (args.params as unknown[] | undefined) ?? [];
      const maxRows = args.max_rows as number | undefined;

      if (DESTRUCTIVE.test(sql)) {
        logger.warn('db_query com comando destrutivo', { sql: sql.slice(0, 200) });
      }

      const outcome = await db.query(sql, params, maxRows);
      return { text: formatOutcome(outcome), rowCount: outcome.rowCount ?? 0, sql };
    })
  );

  server.registerTool(
    'db_list_tables',
    {
      title: 'Listar tabelas',
      description:
        'Lista as tabelas do banco com estimativa de linhas e tamanho em disco. ' +
        'Use para descobrir onde os dados moram antes de escrever uma query.',
      inputSchema: {
        schema: z.string().optional().describe('Schema a inspecionar (padrão: public)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    audited(logger, 'db_list_tables', async (args) => {
      const schema = (args.schema as string | undefined) ?? 'public';
      const sql = `
        SELECT c.relname AS tabela,
               c.reltuples::bigint AS linhas_estimadas,
               pg_size_pretty(pg_total_relation_size(c.oid)) AS tamanho
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relkind IN ('r', 'p')
         ORDER BY c.relname`;
      const outcome = await db.query(sql, [schema], 5000);
      return { text: formatOutcome(outcome), rowCount: outcome.rowCount ?? 0, sql };
    })
  );

  server.registerTool(
    'db_describe_table',
    {
      title: 'Descrever tabela',
      description:
        'Mostra colunas, tipos, nulidade, defaults, constraints, índices e chaves ' +
        'estrangeiras de uma tabela. Use antes de escrever INSERT ou UPDATE.',
      inputSchema: {
        table: z.string().min(1).describe('Nome da tabela, por exemplo "clientes"'),
        schema: z.string().optional().describe('Schema da tabela (padrão: public)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    audited(logger, 'db_describe_table', async (args) => {
      const table = args.table as string;
      const schema = (args.schema as string | undefined) ?? 'public';

      const columns = await db.query(
        `SELECT column_name AS coluna, data_type AS tipo, is_nullable AS aceita_nulo,
                column_default AS padrao, character_maximum_length AS tamanho_max
           FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2
          ORDER BY ordinal_position`,
        [schema, table],
        5000
      );

      if (columns.rows.length === 0) {
        return { text: `Tabela ${schema}.${table} não encontrada.`, rowCount: 0 };
      }

      const constraints = await db.query(
        `SELECT con.conname AS nome, pg_get_constraintdef(con.oid) AS definicao
           FROM pg_constraint con
           JOIN pg_class rel ON rel.oid = con.conrelid
           JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
          WHERE nsp.nspname = $1 AND rel.relname = $2
          ORDER BY con.conname`,
        [schema, table],
        5000
      );

      const indexes = await db.query(
        `SELECT indexname AS nome, indexdef AS definicao
           FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 ORDER BY indexname`,
        [schema, table],
        5000
      );

      const text = [
        `Tabela ${schema}.${table}`,
        '',
        'Colunas:',
        JSON.stringify(columns.rows, null, 2),
        '',
        'Constraints:',
        JSON.stringify(constraints.rows, null, 2),
        '',
        'Índices:',
        JSON.stringify(indexes.rows, null, 2),
      ].join('\n');

      return { text, rowCount: columns.rows.length };
    })
  );

  server.registerTool(
    'db_list_enums',
    {
      title: 'Listar tipos enum',
      description: 'Lista os tipos enum do banco com seus valores aceitos.',
      inputSchema: {
        schema: z.string().optional().describe('Schema a inspecionar (padrão: public)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    audited(logger, 'db_list_enums', async (args) => {
      const schema = (args.schema as string | undefined) ?? 'public';
      const sql = `
        SELECT t.typname AS tipo, array_agg(e.enumlabel ORDER BY e.enumsortorder) AS valores
          FROM pg_type t
          JOIN pg_enum e ON e.enumtypid = t.oid
          JOIN pg_namespace n ON n.oid = t.typnamespace
         WHERE n.nspname = $1
         GROUP BY t.typname ORDER BY t.typname`;
      const outcome = await db.query(sql, [schema], 5000);
      return { text: formatOutcome(outcome), rowCount: outcome.rowCount ?? 0, sql };
    })
  );

  server.registerTool(
    'db_explain',
    {
      title: 'Explicar plano de uma query',
      description:
        'Roda EXPLAIN sobre uma query para inspecionar o plano de execução. ' +
        'Com analyze: true a query é de fato executada — não use com INSERT, UPDATE ou DELETE.',
      inputSchema: {
        sql: z.string().min(1).describe('Query a analisar'),
        params: z.array(z.unknown()).optional().describe('Valores para $1, $2, …'),
        analyze: z
          .boolean()
          .optional()
          .describe('Usa EXPLAIN ANALYZE, executando a query de verdade (padrão: false)'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    audited(logger, 'db_explain', async (args) => {
      const analyze = args.analyze === true;
      const prefix = analyze ? 'EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)' : 'EXPLAIN (FORMAT TEXT)';
      const sql = `${prefix} ${args.sql as string}`;
      const outcome = await db.query(sql, (args.params as unknown[] | undefined) ?? [], 5000);
      const plan = outcome.rows
        .map((row) => (row as Record<string, string>)['QUERY PLAN'] ?? JSON.stringify(row))
        .join('\n');
      return { text: plan || '(plano vazio)', rowCount: outcome.rows.length, sql };
    })
  );
}
