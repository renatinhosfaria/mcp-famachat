import express from 'express';
const router = express.Router();

router.get('/', async (_req, res) => res.json([]));
router.get('/:id', async (_req, res) => res.json({}));
router.post('/:id/convert', async (_req, res) => res.json({}));

export default router;
