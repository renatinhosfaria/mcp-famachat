import { Router } from 'express';
const router = Router();
// Arquivo de teste: deve ser ignorado pelo gerador.
router.get('/nao-deve-aparecer', async (_req, res) => res.json({}));
