/**
 * Configuração do MCP server, lida do ambiente e validada na partida.
 *
 * O processo falha imediatamente se algo obrigatório faltar — um MCP server que
 * sobe sem `MCP_API_KEY` ficaria aberto, e um que sobe sem `DATABASE_URL` só
 * descobriria o problema na primeira chamada do agente.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** Raiz do projeto, tanto rodando de `src/` (tsx) quanto de `dist/` (build). */
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const csv = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  );

const port = z.coerce.number().int().min(1).max(65535);
const positiveInt = z.coerce.number().int().positive();

const schema = z.object({
  PORT: port.default(5100),
  HOST: z.string().default('127.0.0.1'),

  MCP_API_KEY: z.string().min(32, 'MCP_API_KEY precisa ter ao menos 32 caracteres'),
  MCP_IP_ALLOWLIST: csv,
  MCP_STATEFUL: z
    .string()
    .default('0')
    .transform((value) => value === '1' || value.toLowerCase() === 'true'),

  FAMACHAT_API_URL: z.url().default('http://127.0.0.1:5000'),
  FAMACHAT_SERVICE_EMAIL: z.email(),
  FAMACHAT_SERVICE_PASSWORD: z.string().min(1),
  FAMACHAT_REQUEST_TIMEOUT_MS: positiveInt.default(60_000),
  FAMACHAT_MAX_RESPONSE_BYTES: positiveInt.default(1_048_576),

  DATABASE_URL: z.string().min(1),
  DB_STATEMENT_TIMEOUT_MS: positiveInt.default(30_000),
  DB_MAX_ROWS: positiveInt.default(1000),
  DB_POOL_MAX: positiveInt.default(5),

  AUDIT_LOG_PATH: z.string().default(resolve(PROJECT_ROOT, 'logs/audit.jsonl')),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Config = z.infer<typeof schema>;

let cached: Config | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  • ${issue.path.join('.') || '(raiz)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Configuração inválida — confira o .env:\n${issues}`);
  }
  return parsed.data;
}

export function getConfig(): Config {
  cached ??= loadConfig();
  return cached;
}

/** Caminho do manifesto de rotas gerado por `pnpm gen:routes`. */
export const ROUTE_MANIFEST_PATH = resolve(PROJECT_ROOT, 'routes/backend-routes.json');
