/**
 * Uma ferramenta MCP por endpoint do backend.
 *
 * Cada entrada do manifesto vira uma tool `fc_*` cujo handler apenas repassa a
 * chamada ao backend. Nada de regra de negócio aqui: o Express já aplica auth,
 * validação e efeitos colaterais (SLA Cascata, Meta CAPI, webhooks) — duplicar
 * qualquer parte disso criaria dois comportamentos divergentes para a mesma ação.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Logger } from '../audit/logger.js';
import { type FamachatClient, WILDCARD_PARAM } from '../famachat/client.js';
import { type BackendRoute, METHODS_WITH_BODY, type RouteManifest } from '../famachat/manifest.js';
import { assignToolNames } from './naming.js';

/** Métodos que não alteram estado — o `readOnlyHint` guia o agente. */
const READ_ONLY = new Set(['GET']);

/** Path params cujo nome sugere identificador numérico. */
const NUMERIC_PARAM = /(^|_)id$|^id$/i;

function describeRoute(route: BackendRoute): string {
  const parts = [`${route.method} ${route.route}`];
  parts.push(`Módulo ${route.module} (${route.sourceFile}:${route.sourceLine}).`);
  if (route.pathParams.length > 0) {
    parts.push(`Parâmetros de rota: ${route.pathParams.join(', ')}.`);
  }
  if (route.optionalParams.length > 0) {
    parts.push(`Parâmetros opcionais: ${route.optionalParams.join(', ')}.`);
  }
  if (route.alias) {
    parts.push('Rota alias — aponta para o mesmo handler de outra rota equivalente.');
  }
  return parts.join(' ');
}

function paramSchema(param: string): z.ZodTypeAny {
  if (param === WILDCARD_PARAM) {
    return z.string().min(1).describe('Caminho que substitui o * da rota, barras incluídas');
  }
  return NUMERIC_PARAM.test(param)
    ? z.union([z.string(), z.number()]).describe(`Valor de :${param} na rota (identificador numérico)`)
    : z.string().min(1).describe(`Valor de :${param} na rota`);
}

function inputSchemaFor(route: BackendRoute): z.ZodRawShape {
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const param of route.pathParams) {
    shape[param] = paramSchema(param);
  }

  for (const param of route.optionalParams) {
    shape[param] = paramSchema(param).optional().describe(`Valor opcional de :${param} na rota`);
  }

  shape.query = z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Parâmetros de query string, como { limit: 20, status: "Em Atendimento" }');

  if (METHODS_WITH_BODY.has(route.method)) {
    shape.body = z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Corpo JSON da requisição, no formato que o endpoint espera');
  }

  return shape as z.ZodRawShape;
}

type ToolArgs = Record<string, unknown>;

function splitArgs(
  route: BackendRoute,
  args: ToolArgs
): { pathParams: Record<string, string | number>; query?: Record<string, unknown>; body?: unknown } {
  const pathParams: Record<string, string | number> = {};
  for (const param of [...route.pathParams, ...route.optionalParams]) {
    const value = args[param];
    if (typeof value === 'string' || typeof value === 'number') pathParams[param] = value;
  }
  return {
    pathParams,
    query: args.query as Record<string, unknown> | undefined,
    body: args.body,
  };
}

export function registerApiTools(
  server: McpServer,
  manifest: RouteManifest,
  client: FamachatClient,
  logger: Logger
): Map<BackendRoute, string> {
  const names = assignToolNames(manifest.routes);

  for (const [route, name] of names) {
    server.registerTool(
      name,
      {
        title: `${route.method} ${route.route}`,
        description: describeRoute(route),
        inputSchema: inputSchemaFor(route),
        annotations: {
          readOnlyHint: READ_ONLY.has(route.method),
          destructiveHint: route.method === 'DELETE',
          idempotentHint: route.method !== 'POST',
          openWorldHint: true,
        },
      },
      async (args: ToolArgs) => {
        const started = Date.now();
        const { pathParams, query, body } = splitArgs(route, args ?? {});

        try {
          const response = await client.request(route.method, route.route, {
            pathParams,
            query,
            body,
          });

          logger.audit({
            tool: name,
            target: `${route.method} ${route.route}`,
            args: { pathParams, query, body },
            status: response.status < 400 ? 'ok' : 'error',
            httpStatus: response.status,
            durationMs: Date.now() - started,
          });

          const payload = {
            status: response.status,
            statusText: response.statusText,
            truncated: response.truncated,
            body: response.body,
          };

          return {
            content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
            isError: response.status >= 400,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.audit({
            tool: name,
            target: `${route.method} ${route.route}`,
            args: { pathParams, query, body },
            status: 'error',
            durationMs: Date.now() - started,
            error: message,
          });
          return {
            content: [{ type: 'text' as const, text: `Falha ao chamar o backend: ${message}` }],
            isError: true,
          };
        }
      }
    );
  }

  return names;
}
