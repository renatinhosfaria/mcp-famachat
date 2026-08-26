/**
 * Ponto de entrada do MCP server do FamaChat.
 *
 * Sobe em 127.0.0.1 atrás do nginx, que termina o TLS de mcp.famachat.com.br.
 */

import express from 'express';
import { initLogger } from './audit/logger.js';
import { authMiddleware, clientIpOf } from './auth.js';
import { getConfig, ROUTE_MANIFEST_PATH } from './config.js';
import { Database } from './db/pool.js';
import { FamachatClient } from './famachat/client.js';
import { loadManifest } from './famachat/manifest.js';
import { countTools, SERVER_INFO } from './mcp/server.js';
import { createTransportHandler } from './mcp/transport.js';

async function main(): Promise<void> {
  const config = getConfig();
  const logger = initLogger(config.AUDIT_LOG_PATH, config.LOG_LEVEL);

  const manifest = loadManifest(ROUTE_MANIFEST_PATH);
  const client = new FamachatClient(config);
  const db = new Database(config);

  // Falhar na partida é melhor do que descobrir na primeira chamada do agente.
  const dbIdentity = await db.ping();
  logger.info('PostgreSQL conectado', { identidade: dbIdentity });

  const app = express();
  app.disable('x-powered-by');
  // O nginx é o único hop à frente; sem isso o req.ip seria sempre 127.0.0.1.
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '25mb' }));

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      server: SERVER_INFO,
      tools: countTools(manifest),
      backendCommit: manifest.sourceCommit,
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  const handler = createTransportHandler({ manifest, client, db, logger }, config.MCP_STATEFUL, logger);

  app.post('/mcp', authMiddleware(config.MCP_API_KEY, config.MCP_IP_ALLOWLIST), async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Falha ao processar requisição MCP', { message, ip: clientIpOf(req) });
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Erro interno do servidor MCP' },
          id: null,
        });
      }
    }
  });

  // GET e DELETE em /mcp fazem parte do Streamable HTTP (stream de notificações e
  // encerramento de sessão). Em modo stateless não há o que servir.
  app.all('/mcp', authMiddleware(config.MCP_API_KEY, config.MCP_IP_ALLOWLIST), (req, res) => {
    if (req.method === 'POST') return;
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: `Método ${req.method} não suportado — use POST` },
      id: null,
    });
  });

  const server = app.listen(config.PORT, config.HOST, () => {
    logger.info('MCP server no ar', {
      url: `http://${config.HOST}:${config.PORT}/mcp`,
      publico: 'https://mcp.famachat.com.br/mcp',
      ferramentas: countTools(manifest),
      endpoints: manifest.routes.length,
      backendCommit: manifest.sourceCommit,
      modo: config.MCP_STATEFUL ? 'stateful' : 'stateless',
      usuarioDeServico: client.serviceEmail,
      ipAllowlist: config.MCP_IP_ALLOWLIST.length > 0 ? config.MCP_IP_ALLOWLIST : 'desligada',
    });
  });

  const shutdown = (signal: string): void => {
    logger.info(`Recebido ${signal} — encerrando`);
    server.close(() => {
      void db.close().finally(() => process.exit(0));
    });
    // Não deixa o processo pendurado se alguma conexão não fechar.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
  console.error(`Falha na partida: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
