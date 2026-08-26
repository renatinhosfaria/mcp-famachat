/**
 * Leitura do manifesto de rotas gerado por `pnpm gen:routes`.
 *
 * O manifesto é a fonte de verdade das ferramentas `fc_*`: cada rota do backend
 * vira exatamente uma tool. Se ele estiver ausente ou vazio, o servidor não deve
 * subir fingindo que expõe o FamaChat.
 */

import { readFileSync } from 'node:fs';
import { z } from 'zod';

const routeSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  route: z.string().startsWith('/api'),
  sourceFile: z.string(),
  sourceLine: z.number().int().positive(),
  module: z.string(),
  pathParams: z.array(z.string()),
  optionalParams: z.array(z.string()).default([]),
  alias: z.boolean(),
});

const manifestSchema = z.object({
  version: z.literal(1),
  sourceRoot: z.string(),
  sourceCommit: z.string(),
  generatedAt: z.string(),
  counts: z.object({ total: z.number(), unique: z.number(), aliases: z.number() }),
  routes: z.array(routeSchema).min(1, 'manifesto sem rotas — rode `pnpm gen:routes`'),
});

export type BackendRoute = z.infer<typeof routeSchema>;
export type RouteManifest = z.infer<typeof manifestSchema>;

/** Métodos que carregam corpo — define se a tool ganha o campo `body`. */
export const METHODS_WITH_BODY = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function loadManifest(path: string): RouteManifest {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(
      `Manifesto de rotas não encontrado em ${path}. Rode \`pnpm gen:routes\`. (${
        error instanceof Error ? error.message : String(error)
      })`
    );
  }

  const parsed = manifestSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `  • ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Manifesto de rotas inválido:\n${issues}`);
  }
  return parsed.data;
}
