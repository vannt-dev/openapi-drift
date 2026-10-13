export default async function usersRoutes(fastify) {
  fastify.get('/', async (request) => {
    const { page, limit = 20 } = request.query;
    return { page, limit };
  });

  fastify.get('/:id', async (request) => ({ id: request.params.id }));

  fastify.post('/', async (request, reply) => {
    reply.code(201);
    return request.body;
  });

  fastify.patch('/:id', async (request) => request.body);

  fastify.delete('/:id', async (request, reply) => reply.code(204).send());
}
