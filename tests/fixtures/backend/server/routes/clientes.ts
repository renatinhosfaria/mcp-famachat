import type { Express } from 'express';
import { httpClient } from '../services/http-client';

export function registerClienteRoutes(app: Express) {
  app.get('/api/clientes', async (_req, res) => res.json([]));
  app.delete('/api/clientes/notes/:noteId', async (_req, res) => res.json({}));
  app.post('/api/rate-limit/reset/:userId?', async (_req, res) => res.json({}));
  app.delete('/api/storage/files/*', async (_req, res) => res.json({}));

  // Cliente HTTP externo: NÃO é uma rota, mesmo tendo a mesma forma de chamada.
  void httpClient.get('/externo/coisa', { timeout: 1000 });
}
