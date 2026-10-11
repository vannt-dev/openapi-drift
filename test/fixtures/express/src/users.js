import { Router } from 'express';

const router = Router();

router.get('/', (req, res) => res.json([]));
router.get('/:id', (req, res) => res.json({ id: req.params.id }));
router.post('/', (req, res) => res.status(201).json(req.body));
router.delete('/:id(\\d+)', (req, res) => res.status(204).end());

export default router;
