import type { Router } from 'express';
export function registerWebhookEventsRoutes(router: Router) {
  router.get('/api/webhooks/events', async (_req, res) => res.json([]));
}
