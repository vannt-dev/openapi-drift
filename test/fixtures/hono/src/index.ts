import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import users from './routes/users';
import { orders } from './routes/orders.js';
import { admin as adminRoutes } from './routes/admin';

type Env = { Bindings: { DB: string } };

const app = new Hono<Env>().basePath('/api');

// middleware only: no route
app.use('*', cors());
app.use('/admin/*', async (c, next) => {
  await next();
});

app.get('/health', (c) => c.json({ ok: true }));

app.route('/users', users);
app.route('/orders', orders);
app.route('/admin', adminRoutes);

// a base path of its own, under the one of the app
const v2 = app.basePath('/v2');
v2.get('/reports/:day{[0-9]{4}-[0-9]{2}-[0-9]{2}}', (c) => c.json({}));

app.on(['PUT', 'DELETE'], '/items/:id', (c) => c.body(null, 204));
app.on('PURGE', '/cache', (c) => c.text('purged'));

// app.get('/commented-out', (c) => c.text('no'))
const cache = new Map<string, string>();
cache.get('/not-a-route');

app.mount('/legacy', legacyApp.fetch);

app.notFound((c) => c.text('not found', 404));

serve({ fetch: app.fetch, port: 3000 });

export default app;
