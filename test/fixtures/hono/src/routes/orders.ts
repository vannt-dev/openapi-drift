import { Hono } from 'hono';
import { listItems } from '../handlers';

export const orders = new Hono()
  .get('/', (c) => c.json([]))
  .get('/:orderId/items/*', listItems)
  .put('/:orderId{[0-9]+}', (c) => c.json({}));
