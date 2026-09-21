import assert from "node:assert/strict";
import { test } from "node:test";

// Imports instantiate Prisma but every persistence/network operation is replaced below.
process.env.DB_CONNECTION = "default";
process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:15432/garsone_test";
const { syncQrConnection, qrSyncConfigSchema } = await import("../dist/lib/qrSync.js");

const eventId = "a7a8c9d0-1234-4567-8123-123456789abc";
const otherEventId = "b7a8c9d0-1234-4567-8123-123456789abc";
const storeId = "c7a8c9d0-1234-4567-8123-123456789abc";
const tableId = "d7a8c9d0-1234-4567-8123-123456789abc";
const connection = { eventId, cloudApiUrl: "https://architect.example.com/api/", token: "A".repeat(43) };
const bundle = {
  schemaVersion: 1,
  event: {
    id: eventId, storeId, storeSlug: "noor", name: "Noor event",
    publicAppUrl: "http://noor-node.local:8080", publicApiUrl: "http://noor-node.local:8080/api",
    revision: 4, isActive: true,
    assignments: [{ publicCode: "GT-ABCD-2345", tableId, label: "Table 1", isActive: true }],
  },
  exportedAt: "2026-09-21T12:00:00.000Z",
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("sync configuration accepts one event or at most 32 distinct HTTPS event connections", async () => {
  assert.equal(qrSyncConfigSchema.parse(connection)[0].cloudApiUrl, "https://architect.example.com/api");
  assert.equal(qrSyncConfigSchema.parse([connection, { ...connection, eventId: otherEventId }]).length, 2);
  assert.throws(() => qrSyncConfigSchema.parse([]));
  assert.throws(() => qrSyncConfigSchema.parse([connection, connection]));
  assert.throws(() => qrSyncConfigSchema.parse(Array(33).fill(connection)));
  for (const cloudApiUrl of ["http://architect.example.com/api", "https://user:secret@architect.example.com", "https://architect.example.com?token=secret", "https://architect.example.com#fragment", "file:///etc/passwd"]) {
    let calls = 0;
    await assert.rejects(() => syncQrConnection({ ...connection, cloudApiUrl }, "noor", {
      fetch: async () => { calls++; return json({ bundle }); },
      importBundle: async () => { calls++; },
    }));
    assert.equal(calls, 0);
  }
});

test("only sends scoped token over HTTPS, refuses redirects and persists before acknowledgement", async () => {
  const actions = [];
  const result = await syncQrConnection(connection, "noor", {
    fetch: async (url, options) => {
      assert.match(url, /^https:\/\/architect\.example\.com\/api\/qr-sync\/events\//);
      assert.equal(options.redirect, "error");
      assert.ok(options.signal instanceof AbortSignal);
      assert.equal(options.headers.Authorization, `Bearer ${connection.token}`);
      assert.equal(options.headers.Accept, "application/json");
      if (url.endsWith("/ack")) {
        actions.push("ack");
        assert.equal(options.method, "POST");
        assert.deepEqual(JSON.parse(options.body), { appliedRevision: 4 });
        return json({ ok: true, appliedRevision: 4 });
      }
      actions.push("read");
      return json({ bundle });
    },
    importBundle: async (value) => {
      actions.push("persist");
      assert.deepEqual(value, bundle);
    },
  });
  assert.deepEqual(actions, ["read", "persist", "ack"]);
  assert.deepEqual(result, { eventId, appliedRevision: 4 });
  assert.ok(!JSON.stringify(result).includes(connection.token));
});

test("wrong event or venue is rejected before any local write or acknowledgement", async () => {
  for (const mutation of [{ id: otherEventId }, { storeSlug: "another-venue" }]) {
    let fetched = 0;
    let writes = 0;
    await assert.rejects(() => syncQrConnection(connection, "noor", {
      fetch: async () => { fetched++; return json({ bundle: { ...bundle, event: { ...bundle.event, ...mutation } } }); },
      importBundle: async () => { writes++; },
    }), /QR_SYNC_EVENT_OR_STORE_MISMATCH/);
    assert.equal(fetched, 1);
    assert.equal(writes, 0);
  }
});

test("redirected, unauthorized, malformed and oversized responses never change the local state", async () => {
  const redirected = json({ bundle });
  Object.defineProperty(redirected, "redirected", { value: true });
  for (const response of [
    Response.redirect("https://different.example.com", 302),
    redirected,
    json({ error: "revoked" }, 401),
    new Response("<html>login</html>", { headers: { "content-type": "text/html" } }),
    new Response("bad json", { headers: { "content-type": "application/json" } }),
    new Response(" ".repeat(512 * 1024 + 1), { headers: { "content-type": "application/json" } }),
    json({ bundle: { ...bundle, event: { ...bundle.event, publicAppUrl: "javascript:alert(1)" } } }),
  ]) {
    let writes = 0;
    let calls = 0;
    await assert.rejects(() => syncQrConnection(connection, "noor", {
      fetch: async () => { calls++; return response; },
      importBundle: async () => { writes++; },
    }));
    assert.equal(writes, 0);
    assert.equal(calls, 1);
  }
});

test("network and import failures retain previous local data and do not acknowledge", async () => {
  for (const failure of ["network", "import"]) {
    const previous = { revision: 3, data: "previous local assignments" };
    let current = previous;
    let fetchCalls = 0;
    await assert.rejects(() => syncQrConnection(connection, "noor", {
      fetch: async () => {
        fetchCalls++;
        if (failure === "network") throw new Error("offline");
        return json({ bundle });
      },
      importBundle: async () => { throw new Error("local import rejected"); },
    }));
    assert.equal(current, previous);
    assert.equal(fetchCalls, 1);
  }
});

test("an acknowledgement failure retains the newly persisted revision for offline customers", async () => {
  let current = { revision: 3 };
  const actions = [];
  await assert.rejects(() => syncQrConnection(connection, "noor", {
    fetch: async (url) => {
      if (url.endsWith("/ack")) {
        actions.push("ack");
        throw new Error("connectivity lost after import");
      }
      actions.push("read");
      return json({ bundle });
    },
    importBundle: async (value) => { actions.push("persist"); current = value.event; },
  }), /connectivity lost/);
  assert.deepEqual(actions, ["read", "persist", "ack"]);
  assert.equal(current.revision, 4);
});
