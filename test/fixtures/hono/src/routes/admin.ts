import { Hono } from 'hono';

const STATS = '/stats-by-name';

export const admin = new Hono();

admin.get('/stats', (c) => c.json({}));
admin.post('/reindex', (c) => {
  c.status(202);
  return c.text('queued');
});
admin.get(STATS, (c) => c.json({}));
