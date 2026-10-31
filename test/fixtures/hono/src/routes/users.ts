import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { userSchema } from '../schema';

const users = new Hono();

users
  .get('/', (c) => {
    const page = c.req.query('page');
    const { limit } = c.req.query();
    return c.json({ page, limit });
  })
  .post('/', zValidator('json', userSchema), (c) => c.json({ id: 1 }, 201));

users.get('/:id', (c) => {
  const user = c.get('user');
  return c.json(user);
});

// no path: the one before it in the chain
users.patch('/:id', (c) => c.json({})).delete((c) => c.body(null, 204));

export default users;
