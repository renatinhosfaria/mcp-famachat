import type { Express } from 'express';
import { agendaRouter } from './modules/agenda';
import leadsRoutes from './routes/leads';
import empreendimentosRoutes from './routes/empreendimentos';
import { registerClienteRoutes } from './routes/clientes';
import { registerOgImageRoutes } from './routes/og-image';
import { registerUploadRoutes } from './routes/uploads';
import { registerWebhookRoutes } from './routes/webhooks';

export async function registerRoutes(app: Express) {
  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.use('/api/leads', leadsRoutes);
  app.use('/api', agendaRouter);
  // Mesmo router montado em dois prefixos — o segundo vira alias.
  app.use('/api/empreendimentos', empreendimentosRoutes);
  app.use('/api/empreendimentos-page', empreendimentosRoutes);

  registerClienteRoutes(app);
  registerOgImageRoutes(app);
  registerUploadRoutes(app);
  registerWebhookRoutes(app);
}
