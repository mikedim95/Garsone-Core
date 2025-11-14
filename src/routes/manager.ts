import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import bcrypt from 'bcrypt';
import { db } from '../db/index.js';
import { authMiddleware, requireRole } from '../middleware/auth.js';
import { ensureStore } from '../lib/store.js';
import { publishMessage } from '../lib/mqtt.js';
import { invalidateMenuCache } from './menu.js';

export async function managerRoutes(fastify: FastifyInstance) {
  const managerOnly = [authMiddleware, requireRole(['manager'])];

  // Image upload via Supabase (service key). Body: { fileName, mimeType, base64, itemId? }
  fastify.post('/manager/uploads/image', { preHandler: managerOnly }, async (request, reply) => {
    try {
      const store = await ensureStore();
      const body = request.body as any;
      const fileName = String(body?.fileName || '').trim();
      const mimeType = String(body?.mimeType || 'application/octet-stream');
      const base64 = String(body?.base64 || '');
      const itemId = String(body?.itemId || '').trim();

      if (!fileName || !base64) {
        return reply.status(400).send({ error: 'fileName and base64 are required' });
      }

      const SUPA_URL = process.env.SUPABASE_URL;
      const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
      const BUCKET = process.env.SUPABASE_BUCKET || 'assets';
      if (!SUPA_URL || !SUPA_KEY) {
        return reply.status(500).send({ error: 'Supabase service not configured on server' });
      }

      const safeName = `${Date.now()}-${fileName.replace(/[^a-zA-Z0-9_\.\-]/g, '-')}`;
      const path = `${store.slug}/${itemId || 'temp'}/${safeName}`;
      const url = `${SUPA_URL.replace(/\/$/, '')}/storage/v1/object/${BUCKET}/${path}`;

      const buffer = Buffer.from(base64.replace(/^data:[^,]*,/, ''), 'base64');

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${SUPA_KEY}`,
          'Content-Type': mimeType,
          'x-upsert': 'true',
        } as any,
        body: buffer,
      } as any);

      if (!res.ok) {
        const txt = await res.text();
        fastify.log.error({ status: res.status, txt }, 'Supabase upload failed');
        return reply.status(400).send({ error: 'Upload failed', detail: txt });
      }

      const publicUrl = `${SUPA_URL.replace(/\/$/, '')}/storage/v1/object/public/${BUCKET}/${path}`;
      return reply.send({ publicUrl, path });
    } catch (e:any) {
      fastify.log.error(e, 'Manager image upload error');
      return reply.status(500).send({ error: 'Upload failed' });
    }
  });

  const serializeManagerTable = (table: any) => ({
    id: table.id,
    label: table.label,
    isActive: table.isActive,
    waiterCount: table._count?.waiterTables ?? 0,
    orderCount: table._count?.orders ?? 0,
  });

  const getTableWithCounts = async (storeId: string, tableId: string) => {
    return db.table.findFirst({
      where: { id: tableId, storeId },
      include: {
        _count: {
          select: {
            waiterTables: true,
            orders: true,
          },
        },
      },
    });
  };

  const tableCreateSchema = z.object({
    label: z.string().trim().min(1).max(50),
    isActive: z.boolean().optional(),
  });

  const tableUpdateSchema = z
    .object({
      label: z.string().trim().min(1).max(50).optional(),
      isActive: z.boolean().optional(),
    })
    .refine((data) => typeof data.label !== 'undefined' || typeof data.isActive !== 'undefined', {
      message: 'No fields to update provided',
      path: ['label'],
    });

  // Tables CRUD
  fastify.get('/manager/tables', { preHandler: managerOnly }, async (_req, reply) => {
    try {
      const store = await ensureStore();
      const tables = await db.table.findMany({
        where: { storeId: store.id },
        orderBy: { label: 'asc' },
        include: {
          _count: {
            select: {
              waiterTables: true,
              orders: true,
            },
          },
        },
      });
      return reply.send({ tables: tables.map(serializeManagerTable) });
    } catch (e) {
      console.error('Failed to list tables', e);
      return reply.status(500).send({ error: 'Failed to list tables' });
    }
  });

  fastify.post('/manager/tables', { preHandler: managerOnly }, async (request, reply) => {
    try {
      const body = tableCreateSchema.parse(request.body);
      const store = await ensureStore();
      const label = body.label.trim();

      const existing = await db.table.findFirst({ where: { storeId: store.id, label } });
      if (existing) {
        return reply.status(409).send({ error: 'Table label already exists' });
      }

      const created = await db.table.create({
        data: {
          storeId: store.id,
          label,
          isActive: body.isActive ?? true,
        },
      });

      const withCounts = await getTableWithCounts(store.id, created.id);
      if (!withCounts) {
        return reply.status(500).send({ error: 'Failed to load created table' });
      }
      return reply.status(201).send({ table: serializeManagerTable(withCounts) });
    } catch (e) {
      if (e instanceof z.ZodError) {
        return reply.status(400).send({ error: 'Invalid request', details: e.errors });
      }
      console.error('Failed to create table', e);
      return reply.status(500).send({ error: 'Failed to create table' });
    }
  });

  fastify.patch('/manager/tables/:id', { preHandler: managerOnly }, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const body = tableUpdateSchema.parse(request.body);
      const store = await ensureStore();

      const table = await db.table.findFirst({ where: { id, storeId: store.id } });
      if (!table) {
        return reply.status(404).send({ error: 'Table not found' });
      }

      const updateData: { label?: string; isActive?: boolean } = {};
      if (typeof body.label !== 'undefined') {
        const label = body.label.trim();
        if (label !== table.label) {
          const duplicate = await db.table.findFirst({ where: { storeId: store.id, label } });
          if (duplicate) {
            return reply.status(409).send({ error: 'Another table already uses that label' });
          }
        }
        updateData.label = label;
      }
      if (typeof body.isActive !== 'undefined') {
        updateData.isActive = body.isActive;
      }

      await db.table.update({
        where: { id },
        data: updateData,
      });

      const withCounts = await getTableWithCounts(store.id, id);
      if (!withCounts) {
        return reply.status(500).send({ error: 'Failed to load updated table' });
      }
      return reply.send({ table: serializeManagerTable(withCounts) });
    } catch (e) {
      if (e instanceof z.ZodError) {
        return reply.status(400).send({ error: 'Invalid request', details: e.errors });
      }
      console.error('Failed to update table', e);
      return reply.status(500).send({ error: 'Failed to update table' });
    }
  });

  fastify.delete('/manager/tables/:id', { preHandler: managerOnly }, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const store = await ensureStore();

      const table = await db.table.findFirst({ where: { id, storeId: store.id } });
      if (!table) {
        return reply.status(404).send({ error: 'Table not found' });
      }

      await db.waiterTable.deleteMany({ where: { storeId: store.id, tableId: id } });

      await db.table.update({
        where: { id },
        data: { isActive: false },
      });

      const withCounts = await getTableWithCounts(store.id, id);
      if (!withCounts) {
        return reply.status(500).send({ error: 'Failed to load table' });
      }
      return reply.send({ table: serializeManagerTable(withCounts) });
    } catch (e) {
      console.error('Failed to deactivate table', e);
      return reply.status(500).send({ error: 'Failed to delete table' });
    }
  });

  // Waiters CRUD
  fastify.get('/manager/waiters', { preHandler: managerOnly }, async (_req, reply) => {
    const store = await ensureStore();
    const waiters = await db.profile.findMany({ where: { storeId: store.id, role: 'WAITER' }, orderBy: { displayName: 'asc' } });
    return reply.send({ waiters: waiters.map(w => ({ id: w.id, email: w.email, displayName: w.displayName })) });
  });

  const waiterCreateSchema = z.object({ email: z.string().email(), password: z.string().min(6), displayName: z.string().min(1) });
  fastify.post('/manager/waiters', { preHandler: managerOnly }, async (request, reply) => {
    try {
      const body = waiterCreateSchema.parse(request.body);
      const store = await ensureStore();
      const passwordHash = await bcrypt.hash(body.password, 10);
      const waiter = await db.profile.create({ data: { storeId: store.id, email: body.email.toLowerCase(), passwordHash, role: 'WAITER', displayName: body.displayName } });
      return reply.status(201).send({ waiter: { id: waiter.id, email: waiter.email, displayName: waiter.displayName } });
    } catch (e) {
      if (e instanceof z.ZodError) return reply.status(400).send({ error: 'Invalid request', details: e.errors });
      return reply.status(500).send({ error: 'Failed to create waiter' });
    }
  });

  const waiterUpdateSchema = z.object({ email: z.string().email().optional(), password: z.string().min(6).optional(), displayName: z.string().min(1).optional() });
  fastify.patch('/manager/waiters/:id', { preHandler: managerOnly }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const body = waiterUpdateSchema.parse(request.body);
      const data: any = {};
      if (body.email) data.email = body.email.toLowerCase();
      if (body.displayName) data.displayName = body.displayName;
      if (body.password) data.passwordHash = await bcrypt.hash(body.password, 10);
      const updated = await db.profile.update({ where: { id }, data });
      return reply.send({ waiter: { id: updated.id, email: updated.email, displayName: updated.displayName } });
    } catch (e) {
      if (e instanceof z.ZodError) return reply.status(400).send({ error: 'Invalid request', details: e.errors });
      return reply.status(500).send({ error: 'Failed to update waiter' });
    }
  });

  fastify.delete('/manager/waiters/:id', { preHandler: managerOnly }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      await db.profile.delete({ where: { id } });
      return reply.send({ success: true });
    } catch {
      return reply.status(500).send({ error: 'Failed to delete waiter' });
    }
  });

  // Items CRUD
  fastify.get('/manager/items', { preHandler: managerOnly }, async (_req, reply) => {
    const store = await ensureStore();
    const items = await db.item.findMany({ where: { storeId: store.id }, orderBy: { sortOrder: 'asc' }, include: { category: true } });
    return reply.send({ items: items.map(i => ({ id: i.id, title: i.title, description: i.description, imageUrl: i.imageUrl, priceCents: i.priceCents, isAvailable: i.isAvailable, categoryId: i.categoryId, category: i.category?.title })) });
  });

  const itemCreateSchema = z.object({ title: z.string().min(1), description: z.string().optional(), imageUrl: z.string().url().max(2048).optional(), priceCents: z.number().int().nonnegative(), categoryId: z.string().uuid(), isAvailable: z.boolean().optional() });
  fastify.post('/manager/items', { preHandler: managerOnly }, async (request, reply) => {
    try {
      const body = itemCreateSchema.parse(request.body);
      const store = await ensureStore();
      const item = await db.item.create({ data: { storeId: store.id, categoryId: body.categoryId, slug: (body.title.toLowerCase().replace(/\s+/g, '-').slice(0, 60) + '-' + Math.random().toString(16).slice(2, 6)), title: body.title, description: body.description, imageUrl: body.imageUrl, priceCents: body.priceCents, isAvailable: body.isAvailable ?? true } });
      invalidateMenuCache();
      publishMessage(`stores/${store.slug}/menu/updated`, { type: 'item.created', itemId: item.id, ts: new Date().toISOString() });
      return reply.status(201).send({ item });
    } catch (e) {
      if (e instanceof z.ZodError) return reply.status(400).send({ error: 'Invalid request', details: e.errors });
      return reply.status(500).send({ error: 'Failed to create item' });
    }
  });

  const itemUpdateSchema = z.object({ title: z.string().min(1).optional(), description: z.string().optional(), imageUrl: z.string().url().max(2048).nullable().optional(), priceCents: z.number().int().nonnegative().optional(), categoryId: z.string().uuid().optional(), isAvailable: z.boolean().optional() });
  fastify.patch('/manager/items/:id', { preHandler: managerOnly }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const body = itemUpdateSchema.parse(request.body);
      const updated = await db.item.update({ where: { id }, data: body });
      invalidateMenuCache();
      const store = await ensureStore();
      publishMessage(`stores/${store.slug}/menu/updated`, { type: 'item.updated', itemId: updated.id, ts: new Date().toISOString() });
      return reply.send({ item: updated });
    } catch (e) {
      if (e instanceof z.ZodError) return reply.status(400).send({ error: 'Invalid request', details: e.errors });
      return reply.status(500).send({ error: 'Failed to update item' });
    }
  });

  fastify.delete('/manager/items/:id', { preHandler: managerOnly }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      // Guard: prevent deleting if there are orderItems referencing this item
      const orderItemCount = await db.orderItem.count({ where: { itemId: id } });
      if (orderItemCount > 0) {
        return reply.status(400).send({ error: 'Cannot delete item: it is referenced by existing orders' });
      }
      // Remove any item-modifier links first
      await db.itemModifier.deleteMany({ where: { itemId: id } });
      await db.item.delete({ where: { id } });
      invalidateMenuCache();
      const store = await ensureStore();
      publishMessage(`stores/${store.slug}/menu/updated`, { type: 'item.deleted', itemId: id, ts: new Date().toISOString() });
      return reply.send({ success: true });
    } catch (e) {
      console.error('Delete item error:', e);
      return reply.status(500).send({ error: 'Failed to delete item' });
    }
  });

  // Modifiers CRUD
  fastify.get('/manager/modifiers', { preHandler: managerOnly }, async (_req, reply) => {
    const store = await ensureStore();
    const modifiers = await db.modifier.findMany({ where: { storeId: store.id }, orderBy: { title: 'asc' }, include: { modifierOptions: { orderBy: { sortOrder: 'asc' } } } });
    return reply.send({ modifiers });
  });

  const modifierCreateSchema = z.object({ title: z.string().min(1), minSelect: z.number().int().min(0).default(0), maxSelect: z.number().int().nullable().optional() });
  fastify.post('/manager/modifiers', { preHandler: managerOnly }, async (request, reply) => {
    try {
      const body = modifierCreateSchema.parse(request.body);
      const store = await ensureStore();
      const modifier = await db.modifier.create({ data: { storeId: store.id, slug: (body.title.toLowerCase().replace(/\s+/g, '-').slice(0, 60) + '-' + Math.random().toString(16).slice(2, 6)), title: body.title, minSelect: body.minSelect, maxSelect: body.maxSelect ?? null } });
      invalidateMenuCache();
      publishMessage(`stores/${store.slug}/menu/updated`, { type: 'modifier.created', modifierId: modifier.id, ts: new Date().toISOString() });
      return reply.status(201).send({ modifier });
    } catch (e) {
      if (e instanceof z.ZodError) return reply.status(400).send({ error: 'Invalid request', details: e.errors });
      return reply.status(500).send({ error: 'Failed to create modifier' });
    }
  });

  const modifierUpdateSchema = z.object({ title: z.string().min(1).optional(), minSelect: z.number().int().min(0).optional(), maxSelect: z.number().int().nullable().optional() });
  fastify.patch('/manager/modifiers/:id', { preHandler: managerOnly }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const body = modifierUpdateSchema.parse(request.body);
      const updated = await db.modifier.update({ where: { id }, data: body });
      invalidateMenuCache();
      const store = await ensureStore();
      publishMessage(`stores/${store.slug}/menu/updated`, { type: 'modifier.updated', modifierId: updated.id, ts: new Date().toISOString() });
      return reply.send({ modifier: updated });
    } catch (e) {
      if (e instanceof z.ZodError) return reply.status(400).send({ error: 'Invalid request', details: e.errors });
      return reply.status(500).send({ error: 'Failed to update modifier' });
    }
  });

  fastify.delete('/manager/modifiers/:id', { preHandler: managerOnly }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      await db.modifier.delete({ where: { id } });
      return reply.send({ success: true });
    } catch {
      return reply.status(500).send({ error: 'Failed to delete modifier' });
    }
  });

  // Modifier Option create/update/delete
  const optionCreateSchema = z.object({ modifierId: z.string().uuid(), title: z.string().min(1), priceDeltaCents: z.number().int().default(0), sortOrder: z.number().int().default(0) });
  fastify.post('/manager/modifier-options', { preHandler: managerOnly }, async (request, reply) => {
    try {
      const body = optionCreateSchema.parse(request.body);
      const store = await ensureStore();
      const opt = await db.modifierOption.create({ data: { storeId: store.id, modifierId: body.modifierId, slug: (body.title.toLowerCase().replace(/\s+/g, '-').slice(0, 60) + '-' + Math.random().toString(16).slice(2, 6)), title: body.title, priceDeltaCents: body.priceDeltaCents, sortOrder: body.sortOrder } });
      return reply.status(201).send({ option: opt });
    } catch (e) {
      if (e instanceof z.ZodError) return reply.status(400).send({ error: 'Invalid request', details: e.errors });
      return reply.status(500).send({ error: 'Failed to create modifier option' });
    }
  });

  const optionUpdateSchema = z.object({ title: z.string().min(1).optional(), priceDeltaCents: z.number().int().optional(), sortOrder: z.number().int().optional() });
  fastify.patch('/manager/modifier-options/:id', { preHandler: managerOnly }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const body = optionUpdateSchema.parse(request.body);
      const updated = await db.modifierOption.update({ where: { id }, data: body });
      return reply.send({ option: updated });
    } catch (e) {
      if (e instanceof z.ZodError) return reply.status(400).send({ error: 'Invalid request', details: e.errors });
      return reply.status(500).send({ error: 'Failed to update modifier option' });
    }
  });

  fastify.delete('/manager/modifier-options/:id', { preHandler: managerOnly }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      await db.modifierOption.delete({ where: { id } });
      return reply.send({ success: true });
    } catch {
      return reply.status(500).send({ error: 'Failed to delete modifier option' });
    }
  });

  // Item-Modifier linking
  const linkSchema = z.object({ itemId: z.string().uuid(), modifierId: z.string().uuid(), isRequired: z.boolean().default(false) });
  fastify.post('/manager/item-modifiers', { preHandler: managerOnly }, async (request, reply) => {
    try {
      const body = linkSchema.parse(request.body);
      const store = await ensureStore();
      const link = await db.itemModifier.upsert({
        where: { itemId_modifierId: { itemId: body.itemId, modifierId: body.modifierId } },
        update: { isRequired: body.isRequired },
        create: { storeId: store.id, itemId: body.itemId, modifierId: body.modifierId, isRequired: body.isRequired },
      });
      return reply.status(201).send({ link });
    } catch (e) {
      if (e instanceof z.ZodError) return reply.status(400).send({ error: 'Invalid request', details: e.errors });
      return reply.status(500).send({ error: 'Failed to link modifier' });
    }
  });

  fastify.delete('/manager/item-modifiers', { preHandler: managerOnly }, async (request, reply) => {
    try {
      const body = linkSchema.parse(request.body);
      await db.itemModifier.delete({ where: { itemId_modifierId: { itemId: body.itemId, modifierId: body.modifierId } } });
      return reply.send({ success: true });
    } catch (e) {
      if (e instanceof z.ZodError) return reply.status(400).send({ error: 'Invalid request', details: e.errors });
      return reply.status(500).send({ error: 'Failed to unlink modifier' });
    }
  });

  // Orders admin (delete or cancel)
  fastify.delete('/manager/orders/:id', { preHandler: managerOnly }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      await db.order.delete({ where: { id } });
      return reply.send({ success: true });
    } catch (e) {
      return reply.status(500).send({ error: 'Failed to delete order' });
    }
  });

  fastify.patch('/manager/orders/:id/cancel', { preHandler: managerOnly }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const updated = await db.order.update({ where: { id }, data: { status: 'CANCELLED' } });
      return reply.send({ order: { id: updated.id, status: updated.status } });
    } catch (e) {
      return reply.status(500).send({ error: 'Failed to cancel order' });
    }
  });

  // Categories CRUD
  fastify.get('/manager/categories', { preHandler: managerOnly }, async (_req, reply) => {
    const store = await ensureStore();
    const categories = await db.category.findMany({ where: { storeId: store.id }, orderBy: { sortOrder: 'asc' } });
    return reply.send({ categories });
  });

  const categoryCreate = z.object({ title: z.string().min(1), sortOrder: z.number().int().optional() });
  fastify.post('/manager/categories', { preHandler: managerOnly }, async (request, reply) => {
    try {
      const body = categoryCreate.parse(request.body);
      const store = await ensureStore();
      const slug = (body.title.toLowerCase().replace(/\s+/g, '-') + '-' + Math.random().toString(16).slice(2, 6)).slice(0, 100);
      const cat = await db.category.create({ data: { storeId: store.id, title: body.title, slug, sortOrder: body.sortOrder ?? 0 } });
      return reply.status(201).send({ category: cat });
    } catch (e) {
      if (e instanceof z.ZodError) return reply.status(400).send({ error: 'Invalid request', details: e.errors });
      return reply.status(500).send({ error: 'Failed to create category' });
    }
  });

  const categoryUpdate = z.object({ title: z.string().min(1).optional(), sortOrder: z.number().int().optional() });
  fastify.patch('/manager/categories/:id', { preHandler: managerOnly }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const body = categoryUpdate.parse(request.body);
      const updated = await db.category.update({ where: { id }, data: body });
      return reply.send({ category: updated });
    } catch (e) {
      if (e instanceof z.ZodError) return reply.status(400).send({ error: 'Invalid request', details: e.errors });
      return reply.status(500).send({ error: 'Failed to update category' });
    }
  });

  fastify.delete('/manager/categories/:id', { preHandler: managerOnly }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      await db.category.delete({ where: { id } });
      return reply.send({ success: true });
    } catch (e) {
      return reply.status(500).send({ error: 'Failed to delete category' });
    }
  });
}
