import { FastifyInstance } from 'fastify';
import { ensureStore, STORE_SLUG } from '../lib/store.js';

export async function webhookRoutes(fastify: FastifyInstance) {
  fastify.post(
    '/payments/viva/webhook',
    {
      config: {
        rawBody: true,
      },
    },
    async (request, reply) => {
      try {
        await ensureStore();

        fastify.log.info(
          {
            provider: 'viva',
            storeSlug: STORE_SLUG,
            headers: request.headers,
            payload: request.body,
          },
          'Received Viva webhook'
        );

        return reply.status(200).send({ ok: true });
      } catch (error) {
        fastify.log.error({ err: error }, 'Failed to handle Viva webhook');
        return reply.status(500).send({ error: 'Failed to process webhook' });
      }
    }
  );
}
