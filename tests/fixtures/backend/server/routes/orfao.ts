import { Router } from 'express';
// Arquivo de rotas que ninguém importa: não existe em runtime.
const router = Router();
router.get('/orfao', async (_req, res) => res.json({}));
export default router;
