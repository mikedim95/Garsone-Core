import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";

// Resolver-only DB doubles keep this HTTP contract suite independent of live data.
process.env.DB_CONNECTION = "default";
process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:15432/garsone_test";
const { db } = await import("../dist/db/index.js");
const { qrTileRoutes, renderPublicMessage } = await import("../dist/routes/qrTiles.js");

const eventId = "a7a8c9d0-1234-4567-8123-123456789abc";
const tableId = "d7a8c9d0-1234-4567-8123-123456789abc";
const storeId = "c7a8c9d0-1234-4567-8123-123456789abc";
const code = "GT-ABCD-2345";
const headers = { accept: "text/html" };
const jsonHeaders = { accept: "application/json" };

test("public QR browser error pages and JSON resolver contract", async (t) => {
  const original = {
    qr: db.qRTile.findUnique,
    event: db.qrEvent.findUnique,
    table: db.table.findFirst,
  };
  let tile = null;
  let event = null;
  let table = { id: tableId, label: "Table 1", isActive: true };
  let throwLookup = false;
  db.qRTile.findUnique = async () => {
    if (throwLookup) throw new Error("internal database detail must not reach the browser");
    return tile;
  };
  db.qrEvent.findUnique = async () => event;
  db.table.findFirst = async () => table;
  const app = Fastify();
  await app.register(qrTileRoutes);
  const assertSafePage = (response, title) => {
    assert.match(response.headers["content-type"], /text\/html/);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.match(response.headers["content-security-policy"], /default-src 'none'/);
    assert.match(response.body, new RegExp(title));
    assert.match(response.body, /member of staff/);
    assert.doesNotMatch(response.body, /<script|<img|https?:\/\/|QR_EVENT_|QR_TILE_|internal database detail/);
    assert.ok(response.body.length < 6000);
  };
  try {
    await t.test("missing or disabled global codes show staff guidance and retain JSON errors", async () => {
      for (const value of [null, { isActive: false }]) {
        tile = value;
        const response = await app.inject({ url: `/q/${code}`, headers });
        assert.equal(response.statusCode, 404);
        assertSafePage(response, "This QR code is unavailable");
        assert.doesNotMatch(response.body, /Try again/);
        const json = await app.inject({ url: `/q/${code}`, headers: jsonHeaders });
        assert.equal(json.statusCode, 404);
        assert.deepEqual(json.json(), { error: "QR_TILE_NOT_FOUND_OR_INACTIVE" });
      }
    });
    await t.test("unassigned or inactive tables show a useful page without retry loops", async () => {
      for (const table of [null, { id: tableId, isActive: false }]) {
        tile = { isActive: true, publicCode: code, tableId: table?.id ?? null, table, store: { slug: "noor" } };
        const response = await app.inject({ url: `/q/${code}`, headers });
        assert.equal(response.statusCode, 200);
        assertSafePage(response, "This table is not ready");
        assert.doesNotMatch(response.body, /Try again/);
        const json = await app.inject({ url: `/q/${code}`, headers: jsonHeaders });
        assert.deepEqual(json.json(), { status: "UNASSIGNED_TILE", storeSlug: "noor", publicCode: code });
      }
    });
    await t.test("missing, malformed and inactive event codes retain their scoped error", async () => {
      for (const id of [eventId, "invalid-event-id"]) {
        const response = await app.inject({ url: `/q/${code}?event=${id}`, headers });
        assert.equal(response.statusCode, 404);
        assertSafePage(response, "This QR code is unavailable");
        const json = await app.inject({ url: `/q/${code}?event=${id}`, headers: jsonHeaders });
        assert.deepEqual(json.json(), { error: "QR_EVENT_TILE_NOT_FOUND_OR_INACTIVE" });
      }
      event = {
        id: eventId, storeId, store: { slug: "noor", name: "Noor" }, isActive: false,
        publicAppUrl: "http://event-pi.local:8080", publicApiUrl: "http://event-pi.local:8080/api",
        assignmentsJson: [{ publicCode: code, tableId, label: null, isActive: true }],
      };
      const disabled = await app.inject({ url: `/q/${code}?event=${eventId}`, headers });
      assert.equal(disabled.statusCode, 404);
      assertSafePage(disabled, "This QR code is unavailable");
    });
    await t.test("event JSON and HTML use the same configured app destination", async () => {
      event.isActive = true;
      const url = `/q/${code}?event=${eventId}`;
      const json = await app.inject({ url, headers: jsonHeaders });
      assert.equal(json.statusCode, 200);
      assert.deepEqual(json.json(), {
        status: "OK", storeSlug: "noor", tableId, tableLabel: "Table 1", publicCode: code, eventId,
        redirectUrl: `http://event-pi.local:8080/table/${tableId}?storeSlug=noor`,
      });
      const html = await app.inject({ url, headers });
      assert.equal(html.statusCode, 302);
      assert.equal(html.headers.location, json.json().redirectUrl);
      event.assignmentsJson[0].tableId = null;
      const unassigned = await app.inject({ url, headers });
      assertSafePage(unassigned, "This table is not ready");
      assert.deepEqual((await app.inject({ url, headers: jsonHeaders })).json(), { status: "UNASSIGNED_TILE", storeSlug: "noor", publicCode: code });
    });
    await t.test("only transient server failure offers a same-URL retry with no private details", async () => {
      throwLookup = true;
      const response = await app.inject({ url: `/q/${code}`, headers });
      assert.equal(response.statusCode, 500);
      assertSafePage(response, "We could not open your table");
      assert.match(response.body, /<a href="">Try again<\/a>/);
      const json = await app.inject({ url: `/q/${code}`, headers: jsonHeaders });
      assert.equal(json.statusCode, 500);
      assert.deepEqual(json.json(), { error: "FAILED_TO_RESOLVE_QR_TILE" });
    });
    await t.test("renderer escapes and bounds all variable text", () => {
      const markup = renderPublicMessage('<script>alert("x")</script>', '<img src=x onerror="alert(1)">&');
      assert.doesNotMatch(markup, /<script|<img/);
      assert.match(markup, /&lt;script&gt;/);
      assert.match(markup, /&quot;/);
      assert.match(markup, /&amp;/);
      const bounded = renderPublicMessage("a".repeat(100000), "b".repeat(100000));
      assert.ok(bounded.length < 6000);
    });
  } finally {
    db.qRTile.findUnique = original.qr;
    db.qrEvent.findUnique = original.event;
    db.table.findFirst = original.table;
    await app.close();
    await db.$disconnect();
  }
});
