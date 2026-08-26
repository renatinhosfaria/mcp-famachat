import { Router } from 'express';
const router = Router();
router.get('/:slug', async (_req, res) => res.json({}));

// O router é montado sob prefixo dentro do próprio arquivo.
export function registerOgImageRoutes(app: Router) {
  app.use('/api/og-image', router);
}
