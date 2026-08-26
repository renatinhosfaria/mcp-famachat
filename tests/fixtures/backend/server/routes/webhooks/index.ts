import type { Router } from 'express';
import { registerWebhookEventsRoutes } from './webhook-events.routes';

// Registro em cascata: a função chama outra, em outro arquivo.
export function registerWebhookRoutes(router: Router) {
  registerWebhookEventsRoutes(router);
}
