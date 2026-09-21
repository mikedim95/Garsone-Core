import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { config } from "dotenv";
import Fastify from "fastify";

// Deliberately refuse production databases: this suite creates and removes its own fixtures.
config({ path: ".env.security-test", override: true });
const database = new URL(process.env.DATABASE_URL || "http://missing");
if (!["127.0.0.1", "localhost"].includes(database.hostname) || database.port !== "15432") {
  throw new Error("QR integration tests require the dedicated local Postgres on port 15432");
}
process.env.DB_CONNECTION = "default";
process.env.JWT_SECRET ||= randomUUID() + randomUUID();
const { db } = await import("../src/db/index.js");
const { signToken } = await import("../src/lib/jwt.js");
const { qrEventRoutes } = await import("../src/routes/qrEvents.js");
const { resolveQrEvent, normalizeQrUrl } = await import("../src/lib/qrEvents.js");

test("QR event management, scoped synchronization and isolated local import", async (t) => {
  const app = Fastify();
  await app.register(qrEventRoutes);
  const suffix = randomUUID().slice(0, 8);
  const store = await db.store.create({ data: { slug: `qr-test-${suffix}`, name: "QR test venue" } });
  const otherStore = await db.store.create({ data: { slug: `qr-other-${suffix}`, name: "Other venue" } });
  const table = await db.table.create({ data: { storeId: store.id, label: "1" } });
  const secondTable = await db.table.create({ data: { storeId: store.id, label: "2" } });
  const foreignTable = await db.table.create({ data: { storeId: otherStore.id, label: "1" } });
  const architect = await db.profile.create({ data: { storeId: store.id, email: `architect-${suffix}@test.invalid`, globalKey: `architect-${suffix}`, passwordHash: "unused-test-fixture", role: "ARCHITECT", isVerified: true } });
  const manager = await db.profile.create({ data: { storeId: store.id, email: `manager-${suffix}@test.invalid`, passwordHash: "unused-test-fixture", role: "MANAGER", isVerified: true } });
  const tokenFor = (id: string, role: "architect" | "manager") => signToken({ userId: id, role, email: "fixture@test.invalid", storeId: store.id, storeSlug: store.slug });
  const headers = { authorization: `Bearer ${tokenFor(architect.id, "architect")}` };
  const managerHeaders = { authorization: `Bearer ${tokenFor(manager.id, "manager")}` };
  const base = `/admin/stores/${store.id}/qr-events`;
  const configBody = {
    name: "Summer event", publicAppUrl: "http://noor-node.local:8080/", publicApiUrl: "http://noor-node.local:8080/api/",
    assignments: [{ publicCode: "GT-ABCD-2345", tableId: table.id, label: "Entrance", isActive: true }],
  };
  let eventId = "";
  let secondEventId = "";
  let latestBundle: any;
  let scopedToken = "";
  const originalLocalOnly = process.env.LOCAL_ONLY;
  const globalTileCount = await db.qRTile.count();
  try {
    await t.test("only architects can manage event configuration", async () => {
      assert.equal((await app.inject({ method: "GET", url: base })).statusCode, 401);
      assert.equal((await app.inject({ method: "GET", url: base, headers: managerHeaders })).statusCode, 403);
      assert.equal((await app.inject({ method: "GET", url: base, headers })).statusCode, 200);
    });
    await t.test("validates URLs, same-venue tables, code uniqueness and assignment limits", async () => {
      for (const publicAppUrl of ["javascript:alert(1)", "http://user:secret@host", "http://host/path", "http://host?x=1", "http://host#x", "http://host\\@evil", "http://host/%0a", " http://host"]) {
        const response = await app.inject({ method: "POST", url: base, headers, payload: { ...configBody, publicAppUrl } });
        assert.equal(response.statusCode, 400, publicAppUrl);
      }
      assert.equal(normalizeQrUrl("https://events.example.com/api/"), "https://events.example.com/api");
      for (const assignments of [
        [{ ...configBody.assignments[0], tableId: foreignTable.id }],
        [configBody.assignments[0], configBody.assignments[0]],
        Array(501).fill(configBody.assignments[0]),
      ]) {
        assert.equal((await app.inject({ method: "POST", url: base, headers, payload: { ...configBody, assignments } })).statusCode, 400);
      }
    });
    await t.test("reuses a public code independently per event and produces local redirects", async () => {
      const created = await app.inject({ method: "POST", url: base, headers, payload: configBody });
      assert.equal(created.statusCode, 201, created.body);
      const first = created.json().event;
      eventId = first.id;
      assert.equal(first.publicAppUrl, "http://noor-node.local:8080");
      assert.equal(first.publicApiUrl, "http://noor-node.local:8080/api");
      const second = await app.inject({ method: "POST", url: base, headers, payload: { ...configBody, name: "Winter event", assignments: [{ ...configBody.assignments[0], tableId: secondTable.id }] } });
      assert.equal(second.statusCode, 201, second.body);
      secondEventId = second.json().event.id;
      assert.equal((await resolveQrEvent(eventId, "gt-abcd-2345"))?.tableId, table.id);
      assert.equal((await resolveQrEvent(secondEventId, "GT-ABCD-2345"))?.tableId, secondTable.id);
      assert.equal((await resolveQrEvent(eventId, "GT-ABCD-2345"))?.redirectUrl, `http://noor-node.local:8080/table/${table.id}?storeSlug=${store.slug}`);
      assert.equal(await resolveQrEvent(randomUUID(), "GT-ABCD-2345"), null);
      assert.equal(await db.qRTile.count(), globalTileCount);
    });
    await t.test("optimistic revisions reject racing or stale edits", async () => {
      const responses = await Promise.all(["Updated A", "Updated B"].map((name) => app.inject({ method: "PATCH", url: `/admin/qr-events/${eventId}`, headers, payload: { expectedRevision: 1, name } })));
      assert.deepEqual(responses.map((response) => response.statusCode).sort(), [200, 409]);
      assert.equal((await app.inject({ method: "PATCH", url: `/admin/qr-events/${eventId}`, headers, payload: { expectedRevision: 1, isActive: false } })).statusCode, 409);
      const exported = await app.inject({ method: "GET", url: `/admin/qr-events/${eventId}/export`, headers });
      assert.equal(exported.statusCode, 200);
      latestBundle = exported.json().bundle;
      assert.equal(latestBundle.event.revision, 2);
      assert.deepEqual(Object.keys(latestBundle.event).sort(), ["id", "storeId", "storeSlug", "name", "publicAppUrl", "publicApiUrl", "revision", "isActive", "assignments"].sort());
      assert.doesNotMatch(exported.body, /passwordHash|syncTokenHash|profiles|orders|settingsJson/);
    });
    await t.test("scoped token cannot manage events or read another event; acknowledgements are bounded", async () => {
      const paired = await app.inject({ method: "POST", url: `/admin/qr-events/${eventId}/pairing`, headers });
      assert.equal(paired.statusCode, 200, paired.body);
      scopedToken = paired.json().token;
      assert.match(scopedToken, /^[A-Za-z0-9_-]{43}$/);
      assert.notEqual((await db.qrEvent.findUniqueOrThrow({ where: { id: eventId } })).syncTokenHash, scopedToken);
      const syncHeaders = { authorization: `Bearer ${scopedToken}` };
      assert.equal((await app.inject({ method: "GET", url: `/qr-sync/events/${eventId}`, headers: syncHeaders })).statusCode, 200);
      assert.equal((await app.inject({ method: "GET", url: `/qr-sync/events/${secondEventId}`, headers: syncHeaders })).statusCode, 401);
      assert.equal((await app.inject({ method: "GET", url: base, headers: syncHeaders })).statusCode, 401);
      assert.equal((await app.inject({ method: "GET", url: `/qr-sync/events/${eventId}?token=${scopedToken}` })).statusCode, 401);
      assert.equal((await app.inject({ method: "POST", url: `/qr-sync/events/${eventId}/ack`, headers: syncHeaders, payload: { appliedRevision: 3 } })).statusCode, 400);
      assert.equal((await app.inject({ method: "POST", url: `/qr-sync/events/${eventId}/ack`, headers: syncHeaders, payload: { appliedRevision: 2 } })).statusCode, 200);
      assert.equal((await app.inject({ method: "POST", url: `/qr-sync/events/${eventId}/ack`, headers: syncHeaders, payload: { appliedRevision: 1 } })).statusCode, 409);
      const rotated = await app.inject({ method: "POST", url: `/admin/qr-events/${eventId}/pairing`, headers });
      assert.equal(rotated.statusCode, 200);
      assert.equal((await app.inject({ method: "GET", url: `/qr-sync/events/${eventId}`, headers: syncHeaders })).statusCode, 401);
      scopedToken = rotated.json().token;
      assert.equal((await app.inject({ method: "DELETE", url: `/admin/qr-events/${eventId}/pairing`, headers })).statusCode, 200);
      assert.equal((await app.inject({ method: "GET", url: `/qr-sync/events/${eventId}`, headers: { authorization: `Bearer ${scopedToken}` } })).statusCode, 401);
    });
    await t.test("local import is idempotent, revision guarded, read only and preserves venue data", async () => {
      const importedBundle = structuredClone(latestBundle);
      importedBundle.event.id = randomUUID();
      const payload = { bundle: importedBundle };
      process.env.LOCAL_ONLY = "false";
      assert.equal((await app.inject({ method: "POST", url: "/admin/qr-events/import", headers, payload })).statusCode, 403);
      process.env.LOCAL_ONLY = "true";
      const first = await app.inject({ method: "POST", url: "/admin/qr-events/import", headers, payload });
      assert.equal(first.statusCode, 200, first.body);
      assert.equal(first.json().event.isImported, true);
      assert.equal(first.json().unchanged, false);
      const again = await app.inject({ method: "POST", url: "/admin/qr-events/import", headers, payload });
      assert.equal(again.statusCode, 200, again.body);
      assert.equal(again.json().unchanged, true);
      const changed = structuredClone(importedBundle);
      changed.event.name = "Changed without revision";
      assert.equal((await app.inject({ method: "POST", url: "/admin/qr-events/import", headers, payload: { bundle: changed } })).statusCode, 409);
      changed.event.revision = 3;
      assert.equal((await app.inject({ method: "POST", url: "/admin/qr-events/import", headers, payload: { bundle: changed } })).statusCode, 200);
      assert.equal((await app.inject({ method: "POST", url: "/admin/qr-events/import", headers, payload })).statusCode, 409);
      assert.equal((await app.inject({ method: "PATCH", url: `/admin/qr-events/${changed.event.id}`, headers, payload: { expectedRevision: 3, name: "Local edit" } })).statusCode, 409);
      assert.equal((await app.inject({ method: "POST", url: `/admin/qr-events/${changed.event.id}/pairing`, headers })).statusCode, 409);
      const invalid = structuredClone(changed);
      invalid.event.revision = 4;
      invalid.event.assignments[0].tableId = foreignTable.id;
      assert.equal((await app.inject({ method: "POST", url: "/admin/qr-events/import", headers, payload: { bundle: invalid } })).statusCode, 400);
      assert.equal(await db.qRTile.count(), globalTileCount);
      assert.equal(await db.table.count({ where: { storeId: store.id } }), 2);
      assert.equal(await db.profile.count({ where: { storeId: store.id } }), 2);
      assert.equal(await db.order.count({ where: { storeId: store.id } }), 0);
      const auditRows = await db.auditLog.findMany({ where: { storeId: store.id } });
      assert.ok(auditRows.some((row) => row.action === "QR_EVENT_IMPORTED"));
      assert.ok(auditRows.some((row) => row.action === "QR_EVENT_PAIRING_REVOKED"));
      assert.ok(auditRows.every((row) => row.actorProfileId === architect.id));
      assert.ok(!JSON.stringify(auditRows).includes(scopedToken));
    });
    await t.test("inactive assignments and inactive tables cannot redirect customers", async () => {
      await db.table.update({ where: { id: table.id }, data: { isActive: false } });
      assert.equal((await resolveQrEvent(eventId, "GT-ABCD-2345"))?.redirectUrl, null);
      await db.table.update({ where: { id: table.id }, data: { isActive: true } });
      const disabled = await app.inject({ method: "PATCH", url: `/admin/qr-events/${eventId}`, headers, payload: { expectedRevision: 2, isActive: false } });
      assert.equal(disabled.statusCode, 200, disabled.body);
      assert.equal((await resolveQrEvent(eventId, "GT-ABCD-2345"))?.redirectUrl, null);
      assert.equal((await resolveQrEvent(secondEventId, "GT-ABCD-2345"))?.tableId, secondTable.id);
    });
  } finally {
    process.env.LOCAL_ONLY = originalLocalOnly;
    await app.close();
    await db.auditLog.deleteMany({ where: { storeId: { in: [store.id, otherStore.id] } } });
    await db.store.deleteMany({ where: { id: { in: [store.id, otherStore.id] } } });
    await db.$disconnect();
  }
});
