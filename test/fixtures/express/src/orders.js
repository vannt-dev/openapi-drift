const express = require('express');

const router = express.Router();

router.get('/', (req, res) => res.json([]));
router.put('/:orderId', (req, res) => res.json({ id: req.params.orderId }));

module.exports = router;
