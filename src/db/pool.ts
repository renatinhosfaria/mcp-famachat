/**
 * Pool de conexões com o PostgreSQL de produção do FamaChat.
 *
 * `application_name=mcp-hermes` separa, nos logs e no `pg_stat_activity`, o que o
 * agente executou do que veio do backend — a única forma de auditar do lado do
 * banco, já que o acesso concedido é irrestrito.
 */

import pg from 'pg';
import type { Config } from '../config.js';

export type QueryOutcome = {
  command: string;
  rowCount: number | null;
  rows: unknown[];
  fields: { name: string; dataTypeId: number }[];
  truncated: boolean;
  durationMs: number;
};

export class Database {
  private readonly pool: pg.Pool;

  constructor(
    private readonly config: Pick<
      Config,
      'DATABASE_URL' | 'DB_STATEMENT_TIMEOUT_MS' | 'DB_MAX_ROWS' | 'DB_POOL_MAX'
    >
  ) {
    this.pool = new pg.Pool({
      connectionString: config.DATABASE_URL,
      max: config.DB_POOL_MAX,
      application_name: 'mcp-hermes',
      statement_timeout: config.DB_STATEMENT_TIMEOUT_MS,
      idle_timeout_millis: 30_000,
      connectionTimeoutMillis: 15_000,
    } as pg.PoolConfig);

    // Sem este handler, um erro em conexão ociosa derruba o processo.
    this.pool.on('error', (error) => {
      console.error(`[db] erro em conexão ociosa: ${error.message}`);
    });
  }

  async query(sql: string, params: unknown[] = [], maxRows?: number): Promise<QueryOutcome> {
    const limit = maxRows ?? this.config.DB_MAX_ROWS;
    const started = Date.now();
    const result = await this.pool.query(sql, params);

    // `pg` devolve um array de resultados quando o texto tem múltiplos comandos.
    const single = Array.isArray(result) ? (result.at(-1) as pg.QueryResult) : result;
    const rows = single?.rows ?? [];
    const truncated = rows.length > limit;

    return {
      command: single?.command ?? 'UNKNOWN',
      rowCount: single?.rowCount ?? null,
      rows: truncated ? rows.slice(0, limit) : rows,
      fields: (single?.fields ?? []).map((f) => ({ name: f.name, dataTypeId: f.dataTypeID })),
      truncated,
      durationMs: Date.now() - started,
    };
  }

  /** Verifica conectividade na partida, para falhar cedo em vez de na 1ª tool call. */
  async ping(): Promise<string> {
    const result = await this.pool.query<{ db: string; usr: string }>(
      'SELECT current_database() AS db, current_user AS usr'
    );
    const row = result.rows[0];
    return row ? `${row.usr}@${row.db}` : 'desconhecido';
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
