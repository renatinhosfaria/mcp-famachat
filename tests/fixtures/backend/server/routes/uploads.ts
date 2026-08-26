import type express from 'express';

// Parâmetro com tipo qualificado.
export function registerUploadRoutes(app: express.Express) {
  app.post('/api/uploads/imovel/:imovelId', async (_req, res) => res.json({}));
}
