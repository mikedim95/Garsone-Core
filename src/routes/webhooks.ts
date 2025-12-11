import { FastifyInstance } from 'fastify';
import { ensureStore, STORE_SLUG } from '../lib/store.js';
import { verifyVivaWebhook, isPaymentSuccessful } from '../lib/viva.js';
import { db } from '../db/index.js';

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
        const payload = request.body;

        // Verify webhook payload structure
        if (!verifyVivaWebhook(payload)) {
          fastify.log.warn(
            { payload },
            'Invalid Viva webhook payload structure'
          );
          return reply.status(400).send({ error: 'Invalid webhook payload' });
        }

        await ensureStore();

        fastify.log.info(
          {
            provider: 'viva',
            storeSlug: STORE_SLUG,
            transactionId: payload.transactionId,
            orderCode: payload.orderCode,
            statusCode: payload.statusCode,
          },
          'Received Viva webhook'
        );

        // Check if payment was successful
        if (!isPaymentSuccessful(payload.statusCode)) {
          fastify.log.warn(
            { statusCode: payload.statusCode, orderCode: payload.orderCode },
            'Viva payment not successful'
          );
          return reply.status(200).send({ ok: true });
        }

        // Update order with successful payment status if it exists
        // In this demo flow, the order is created after payment is confirmed
        // The actual order creation happens on the frontend after redirect
        
        fastify.log.info(
          { transactionId: payload.transactionId, orderCode: payload.orderCode },
          'Viva payment confirmed'
        );

        return reply.status(200).send({ ok: true });
      } catch (error) {
        fastify.log.error({ err: error }, 'Failed to handle Viva webhook');
        return reply.status(500).send({ error: 'Failed to process webhook' });
      }
    }
  );
}
