/**
 * Transporte Streamable HTTP.
 *
 * O Hermes 0.14.0 abre a conexão MCP uma vez no boot do daemon e a mantém viva,
 * reconectando com backoff se cair. Isso favorece o modo **stateless**: sem
 * `Mcp-Session-Id` para invalidar, um restart do PM2 é transparente — a próxima
 * requisição simplesmente funciona, em vez de devolver 404 de sessão perdida.
 *
 * `MCP_STATEFUL=1` liga o modo com sessão, caso algum cliente futuro exija.
 */

import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Request, Response } from 'express';
import type { Logger } from '../audit/logger.js';
import { createMcpServer, type ServerDeps } from './server.js';

export type TransportHandler = (req: Request, res: Response) => Promise<void>;

/**
 * Modo stateless: um servidor e um transporte efêmeros por requisição, fechados
 * quando a resposta termina. Sem estado compartilhado entre chamadas.
 */
function statelessHandler(deps: ServerDeps): TransportHandler {
  return async (req, res) => {
    const server = createMcpServer(deps);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };
}

/**
 * Modo stateful: uma sessão por cliente, endereçada pelo header `Mcp-Session-Id`.
 */
function statefulHandler(deps: ServerDeps, logger: Logger): TransportHandler {
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  return async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    const existing = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;

    if (existing) {
      await existing.handleRequest(req, res, req.body);
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        sessions.set(id, transport);
        logger.info('Sessão MCP iniciada', { sessionId: id, sessões: sessions.size });
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
        logger.info('Sessão MCP encerrada', { sessionId: id, sessões: sessions.size });
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };

    const server = createMcpServer(deps);
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };
}

export function createTransportHandler(
  deps: ServerDeps,
  stateful: boolean,
  logger: Logger
): TransportHandler {
  return stateful ? statefulHandler(deps, logger) : statelessHandler(deps);
}
