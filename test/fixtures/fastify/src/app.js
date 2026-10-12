import Fastify from 'fastify';
import usersRoutes from './users.js';

const fastify = Fastify({ logger: false });
const config = new Map([['db.host', 'localhost']]);
const cache = new Map();

fastify.get('/health', async () => ({ ok: true, db: config.get('db.host'), cached: cache.get('health') }));
// Fastify answers HEAD /health by itself; a HEAD of its own is for a path without a GET
fastify.head('/ping', async (request, reply) => reply.code(200).send());

// fastify.get('/commented-out', async () => ({})) must not count
fastify.register(usersRoutes, { prefix: '/api/users' });
fastify.register(import('./orders.js'), { prefix: '/api/orders' });

// a plugin written in the file
async function admin(instance) {
  instance.get('/stats', async () => ({}));
  instance.post('/reindex', async (request, reply) => reply.code(202).send());
}
fastify.register(admin, { prefix: '/admin' });

// a plugin written in the call, with one more inside it
fastify.register(
  async (api) => {
    api.register(
      async (reports) => {
        reports.get('/daily', async () => []);
      },
      { prefix: '/reports' }
    );
  },
  { prefix: '/api/v2' }
);

fastify.get('/files/*', async () => 'file');

export default fastify;
