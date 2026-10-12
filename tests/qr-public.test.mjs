import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";

// Resolver-only DB doubles keep this HTTP contract suite independent of live data.
process.env.DB_CONNECTION = "default";
process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:15432/garsone_test";
process.env.MQTT_DISABLED = "true";
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
        status: "OK", storeSlug: "noor", tableId, tableLabel: "Table 1", publicCode: code,
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

test("opaque public QR tokens resolve locally without publishing event identifiers", async (t) => {
  const token = "QT-0123456789ABCDEF0123456789ABCDEF";
  const otherToken = "QT-FEDCBA9876543210FEDCBA9876543210";
  const original = {
    qr: db.qRTile.findUnique,
    events: db.qrEvent.findMany,
    event: db.qrEvent.findUnique,
    table: db.table.findFirst,
  };
  const makeEvent = () => ({
    id: eventId, storeId, store: { slug: "noor", name: "Noor" }, isActive: true,
    publicAppUrl: "http://192.168.1.116:8080", publicApiUrl: "http://192.168.1.116:8080/api",
    assignmentsJson: [{ publicCode: code, publicToken: token, tableId, label: "Entrance", isActive: true }],
  });
  let candidates = [makeEvent()];
  let table = { id: tableId, label: "Table 1", isActive: true };
  let globalLookups = 0;
  db.qRTile.findUnique = async () => {
    globalLookups++;
    throw new Error("Opaque event tokens must never fall back to global inventory");
  };
  db.qrEvent.findMany = async ({ where, take }) => {
    assert.equal(take, 2, "token lookup must detect ambiguity rather than select the first match");
    assert.equal(where.assignmentsJson.array_contains.length, 1);
    assert.match(where.assignmentsJson.array_contains[0].publicToken, /^QT-[0-9A-F]{32}$/);
    return candidates;
  };
  db.qrEvent.findUnique = async () => { throw new Error("A public token must not require the event identifier"); };
  db.table.findFirst = async ({ where }) => {
    assert.equal(where.storeId, storeId, "table lookup must stay scoped to the event venue");
    assert.equal(where.id, tableId);
    return table;
  };
  const app = Fastify();
  await app.register(qrTileRoutes);
  try {
    await t.test("JSON and browser redirect use only the opaque token", async () => {
      const url = `/q/${token}`;
      const json = await app.inject({ url, headers: jsonHeaders });
      assert.equal(json.statusCode, 200, json.body);
      assert.equal(json.headers["referrer-policy"], "no-referrer");
      assert.equal(json.json().status, "OK");
      assert.equal(json.json().tableId, tableId);
      assert.equal(json.json().storeSlug, "noor");
      assert.equal(json.json().redirectUrl, `http://192.168.1.116:8080/table/${tableId}?storeSlug=noor`);
      assert.equal(Object.hasOwn(json.json(), "eventId"), false);
      assert.ok(!json.body.includes(eventId));
      const html = await app.inject({ url, headers });
      assert.equal(html.statusCode, 302);
      assert.equal(html.headers["referrer-policy"], "no-referrer");
      assert.equal(html.headers.location, json.json().redirectUrl);
      assert.ok(!html.headers.location.includes(eventId));
      assert.ok(!html.headers.location.includes("event="));
    });
    await t.test("unknown or malformed tokens cannot resolve a global tile", async () => {
      candidates = [];
      for (const value of [otherToken, "QT-invalid", `QT-${"A".repeat(31)}`, `QT-${"A".repeat(33)}`]) {
        const response = await app.inject({ url: `/q/${value}`, headers: jsonHeaders });
        assert.equal(response.statusCode, 404, response.body);
        assert.ok(!response.body.includes(eventId));
      }
      assert.equal(globalLookups, 0);
    });
    await t.test("disabled events, assignments and tables cannot redirect", async () => {
      for (const disabled of ["event", "assignment", "table"]) {
        candidates = [makeEvent()];
        table = { id: tableId, label: "Table 1", isActive: disabled !== "table" };
        if (disabled === "event") candidates[0].isActive = false;
        if (disabled === "assignment") candidates[0].assignmentsJson[0].isActive = false;
        const response = await app.inject({ url: `/q/${token}`, headers: jsonHeaders });
        assert.equal(response.statusCode, 404, `${disabled}: ${response.body}`);
        assert.equal(response.headers.location, undefined);
        assert.ok(!response.body.includes(eventId));
      }
    });
    await t.test("unassigned token gives staff guidance and a missing venue table fails closed", async () => {
      candidates = [makeEvent()];
      candidates[0].assignmentsJson[0].tableId = null;
      const response = await app.inject({ url: `/q/${token}`, headers: jsonHeaders });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().status, "UNASSIGNED_TILE");
      assert.equal(response.headers.location, undefined);
      assert.ok(!response.body.includes(eventId));
      const html = await app.inject({ url: `/q/${token}`, headers });
      assert.match(html.body, /This table is not ready/);
      candidates = [makeEvent()];
      table = null;
      const foreign = await app.inject({ url: `/q/${token}`, headers: jsonHeaders });
      assert.equal(foreign.statusCode, 404, foreign.body);
      assert.equal(foreign.headers.location, undefined);
    });
    await t.test("ambiguous tokens across events are rejected without picking a destination", async () => {
      table = { id: tableId, label: "Table 1", isActive: true };
      candidates = [makeEvent(), { ...makeEvent(), id: "b7a8c9d0-1234-4567-8123-123456789abc" }];
      const response = await app.inject({ url: `/q/${token}`, headers: jsonHeaders });
      assert.equal(response.statusCode, 404, response.body);
      assert.equal(response.headers.location, undefined);
      assert.ok(!response.body.includes(eventId));
      assert.equal(globalLookups, 0);
    });
  } finally {
    db.qRTile.findUnique = original.qr;
    db.qrEvent.findMany = original.events;
    db.qrEvent.findUnique = original.event;
    db.table.findFirst = original.table;
    await app.close();
    await db.$disconnect();
  }
});
