import { FastifyInstance } from "fastify";
import { Prisma, Role } from "@prisma/client";
import { z } from "zod";
import { db } from "../db/index.js";
import { ensureStore } from "../lib/store.js";
import { authMiddleware, requireRole } from "../middleware/auth.js";
import { publishMessage } from "../lib/mqtt.js";

const assignmentSchema = z.object({
  waiterId: z.string().uuid(),
  tableId: z.string().uuid(),
});

type WaiterTableWithRelations = Prisma.WaiterTableGetPayload<{
  include: {
    waiter: { include: { waiterType: true } };
    table: { select: { id: true; label: true; isActive: true } };
  };
}>;

function serializeAssignment(assignment: WaiterTableWithRelations) {
  return {
    waiterId: assignment.waiterId,
    tableId: assignment.tableId,
    waiter: {
      id: assignment.waiter.id,
      email: assignment.waiter.email,
      displayName: assignment.waiter.displayName ?? assignment.waiter.email,
      waiterTypeId: assignment.waiter.waiterTypeId ?? null,
      waiterType: assignment.waiter.waiterType
        ? {
            id: assignment.waiter.waiterType.id,
            slug: assignment.waiter.waiterType.slug,
            title: assignment.waiter.waiterType.title,
            printerTopic: assignment.waiter.waiterType.printerTopic,
          }
        : null,
    },
    table: {
      id: assignment.table.id,
      label: assignment.table.label,
      active: assignment.table.isActive,
    },
  };
}

export async function waiterTableRoutes(fastify: FastifyInstance) {
  const managerOnly = [authMiddleware, requireRole(["manager", "architect"])];

  fastify.get(
    "/waiter-tables",
    {
      preHandler: managerOnly,
    },
    async (request, reply) => {
      try {
        const store = await ensureStore(request);

        const [assignments, waiters, tables] = await Promise.all([
          db.waiterTable.findMany({
            where: { storeId: store.id },
            include: { 
              waiter: { include: { waiterType: true } }, 
              table: { select: { id: true, label: true, isActive: true } },
            },
            orderBy: { createdAt: "asc" },
          }),
          db.profile.findMany({
            where: { storeId: store.id, role: Role.WAITER },
            orderBy: { displayName: "asc" },
            include: { waiterType: true },
          }),
          db.table.findMany({
            where: { storeId: store.id },
            orderBy: { label: "asc" },
          }),
        ]);

        return reply.send({
          assignments: assignments.map(serializeAssignment),
          waiters: waiters.map((waiter) => ({
            id: waiter.id,
            email: waiter.email,
            displayName: waiter.displayName ?? waiter.email,
            waiterTypeId: waiter.waiterTypeId ?? null,
            waiterType: waiter.waiterType
              ? {
                  id: waiter.waiterType.id,
                  slug: waiter.waiterType.slug,
                  title: waiter.waiterType.title,
                  printerTopic: waiter.waiterType.printerTopic,
                }
              : null,
          })),
          tables: tables.map((table) => ({
            id: table.id,
            label: table.label,
            active: table.isActive,
          })),
        });
      } catch (error) {
        console.error("List waiter assignments error:", error);
        return reply
          .status(500)
          .send({ error: "Failed to fetch waiter assignments" });
      }
    }
  );

  fastify.post(
    "/waiter-tables",
    {
      preHandler: managerOnly,
    },
    async (request, reply) => {
      try {
        const body = assignmentSchema.parse(request.body);
        const store = await ensureStore(request);

        const [waiter, table] = await Promise.all([
          db.profile.findFirst({
            where: { id: body.waiterId, storeId: store.id, role: Role.WAITER },
          }),
          db.table.findFirst({
            where: { id: body.tableId, storeId: store.id },
          }),
        ]);

        if (!waiter) {
          return reply.status(404).send({ error: "Waiter not found" });
        }

        if (!table) {
          return reply.status(404).send({ error: "Table not found" });
        }

        const assignment = await db.waiterTable.upsert({
          where: {
            storeId_waiterId_tableId: {
              storeId: store.id,
              waiterId: waiter.id,
              tableId: table.id,
            },
          },
          update: {},
          create: {
            storeId: store.id,
            waiterId: waiter.id,
            tableId: table.id,
          },
          include: { 
            waiter: true, 
            table: { select: { id: true, label: true, isActive: true } },
          },
        });

        publishMessage(`${store.slug}/waiter/assignments`, {
          action: "assigned",
          waiterId: waiter.id,
          tableId: table.id,
          tableLabel: table.label,
        }, { roles: ["waiter"] });

        return reply.status(201).send({
          assignment: serializeAssignment(assignment),
        });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return reply
            .status(400)
            .send({ error: "Invalid request", details: error.errors });
        }

        console.error("Create waiter assignment error:", error);
        return reply
          .status(500)
          .send({ error: "Failed to assign waiter to table" });
      }
    }
  );

  fastify.delete(
    "/waiter-tables",
    {
      preHandler: managerOnly,
    },
    async (request, reply) => {
      try {
        const body = assignmentSchema.parse(request.body);
        const store = await ensureStore(request);

        await db.waiterTable.delete({
          where: {
            storeId_waiterId_tableId: {
              storeId: store.id,
              waiterId: body.waiterId,
              tableId: body.tableId,
            },
          },
        });

        publishMessage(`${store.slug}/waiter/assignments`, {
          action: "removed",
          waiterId: body.waiterId,
          tableId: body.tableId,
        }, { roles: ["waiter"] });

        return reply.send({ success: true });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return reply
            .status(400)
            .send({ error: "Invalid request", details: error.errors });
        }

        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2025"
        ) {
          return reply.status(404).send({ error: "Assignment not found" });
        }

        console.error("Delete waiter assignment error:", error);
        return reply
          .status(500)
          .send({ error: "Failed to remove waiter assignment" });
      }
    }
  );

  // Waiter: get my assigned tables (scoped)
  fastify.get(
    "/waiter/my-tables",
    {
      preHandler: [authMiddleware, requireRole(["waiter"])],
    },
    async (request, reply) => {
      try {
        const store = await ensureStore(request);
        const user = (request as any).user;
        const waiterId = (user as any)?.userId || (user as any)?.id;
        console.log("[waiter/my-tables] user payload", user, "resolvedWaiterId", waiterId, "store", store.slug);
        if (!waiterId) {
          return reply.status(401).send({ error: "Unauthorized" });
        }
        const assignments = await db.waiterTable.findMany({
          where: { storeId: store.id, waiterId },
          include: {
            waiter: true,
            table: { select: { id: true, label: true, isActive: true } },
          },
          orderBy: { createdAt: "asc" },
        });
        const tables = await db.table.findMany({
          where: { storeId: store.id, isActive: true },
          orderBy: { label: "asc" },
          select: { id: true, label: true, isActive: true },
        });

        console.log("[waiter/my-tables] result", {
          store: store.slug,
          waiterId,
          assignments: assignments.map((a) => ({
            tableId: a.tableId,
            tableLabel: a.table?.label,
            waiterId: a.waiterId,
          })),
          tables: tables.map((t) => ({ id: t.id, label: t.label, active: t.isActive })),
        });

        return reply.send({
          assignments: assignments.map(serializeAssignment),
          tables: tables.map((table) => ({
            id: table.id,
            label: table.label,
            active: table.isActive,
          })),
          waiters: [], // not needed for waiter scope
        });
      } catch (error) {
        console.error("Waiter assignments fetch error:", error);
        return reply.status(500).send({ error: "Failed to fetch assignments" });
      }
    }
  );
}
