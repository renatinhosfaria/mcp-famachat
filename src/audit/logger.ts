/**
 * Auditoria append-only e log de aplicação.
 *
 * O agente tem acesso irrestrito ao banco, DDL incluído. A trilha do que ele fez
 * precisa, portanto, viver fora do banco: um arquivo JSONL no disco, que nenhuma
 * tool exposta consegue alcançar.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

/** Argumentos longos (um SQL gigante, um body de upload) não devem inchar o arquivo. */
const MAX_FIELD_CHARS = 4000;

export type AuditRecord = {
  tool: string;
  args?: unknown;
  target?: string;
  status: 'ok' | 'error';
  durationMs: number;
  httpStatus?: number;
  rowCount?: number;
  error?: string;
  clientIp?: string;
};

function truncate(value: string): string {
  return value.length <= MAX_FIELD_CHARS
    ? value
    : `${value.slice(0, MAX_FIELD_CHARS)}…[+${value.length - MAX_FIELD_CHARS} chars]`;
}

function safeStringify(value: unknown): string {
  try {
    return truncate(JSON.stringify(value) ?? 'null');
  } catch {
    return '"[não serializável]"';
  }
}

export class Logger {
  private readonly threshold: number;
  private auditReady = false;

  constructor(
    private readonly auditPath: string,
    level: LogLevel = 'info'
  ) {
    this.threshold = LEVELS[level];
  }

  private write(level: LogLevel, message: string, extra?: unknown): void {
    if (LEVELS[level] < this.threshold) return;
    const stamp = new Date().toISOString();
    const suffix = extra === undefined ? '' : ` ${safeStringify(extra)}`;
    const line = `${stamp} [${level.toUpperCase()}] ${message}${suffix}`;
    if (level === 'error' || level === 'warn') console.error(line);
    else console.log(line);
  }

  debug = (message: string, extra?: unknown): void => this.write('debug', message, extra);
  info = (message: string, extra?: unknown): void => this.write('info', message, extra);
  warn = (message: string, extra?: unknown): void => this.write('warn', message, extra);
  error = (message: string, extra?: unknown): void => this.write('error', message, extra);

  /**
   * Registra uma tool call. Falha de escrita nunca derruba a chamada em si — mas
   * é reportada, já que perder a trilha silenciosamente seria pior.
   */
  audit(record: AuditRecord): void {
    const entry = {
      ts: new Date().toISOString(),
      ...record,
      args: record.args === undefined ? undefined : JSON.parse(safeStringify(record.args)),
      error: record.error ? truncate(record.error) : undefined,
      target: record.target ? truncate(record.target) : undefined,
    };

    try {
      if (!this.auditReady) {
        mkdirSync(dirname(this.auditPath), { recursive: true });
        this.auditReady = true;
      }
      appendFileSync(this.auditPath, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch (error) {
      this.write('error', 'Falha ao escrever a auditoria', {
        path: this.auditPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

let instance: Logger | null = null;

export function initLogger(auditPath: string, level: LogLevel): Logger {
  instance = new Logger(auditPath, level);
  return instance;
}

export function getLogger(): Logger {
  if (!instance) throw new Error('Logger não inicializado — chame initLogger() na partida');
  return instance;
}
