import { listOrders, listItems, replaceOrder } from './handlers.js';

export default async function (fastify) {
  fastify.get('/', listOrders);
  fastify.get('/:orderId/items', { schema: { params: { type: 'object' } } }, listItems);
  fastify.route({
    method: 'PUT',
    url: '/:orderId',
    handler: replaceOrder,
  });
}
