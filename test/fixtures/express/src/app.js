import express from 'express';
import usersRouter from './users.js';
const ordersRouter = require('./orders');

const app = express();

app.get('/health', (req, res) => res.json({ ok: true }));

app.use('/api/users', usersRouter);
app.use('/api/orders', ordersRouter);

const admin = express.Router();
admin.get('/stats', (req, res) => res.json({}));
admin.post('/reindex', (req, res) => res.status(202).end());
app.use('/admin', admin);

app
  .route('/api/items')
  .get((req, res) => res.json([]))
  .post((req, res) => res.status(201).json({ created: ')' }));

// app.get('/commented-out', () => {}) must not count
app.all('/api/echo', (req, res) => res.json(req.body));

export default app;
