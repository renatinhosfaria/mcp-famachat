import { Router } from 'express';
export const agendaRouter = Router();
agendaRouter.get('/appointments', async (_req, res) => res.json([]));
agendaRouter.patch('/appointments/:id', async (_req, res) => res.json({}));
