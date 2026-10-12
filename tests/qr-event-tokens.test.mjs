import assert from "node:assert/strict";
import { test } from "node:test";

// No real database is used: the import test replaces the transaction boundary.
process.env.DB_CONNECTION = "default";
process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:15432/garsone_test";
const { db } = await import("../dist/db/index.js");
const {
  prepareQrAssignments, qrEventCreateSchema, qrEventPatchSchema,
  qrEventBundleSchema, exportQrEvent, importQrEventBundle,
} = await import("../dist/lib/qrEvents.js");

const eventId = "a7a8c9d0-1234-4567-8123-123456789abc";
const storeId = "c7a8c9d0-1234-4567-8123-123456789abc";
const tableId = "d7a8c9d0-1234-4567-8123-123456789abc";
const otherTableId = "e7a8c9d0-1234-4567-8123-123456789abc";
const assignment = { publicCode: "GT-ABCD-2345", tableId, label: "Entrance", isActive: true };
const eventFields = {
  name: "Noor local tables", publicAppUrl: "http://192.168.1.116:8080", publicApiUrl: "http://192.168.1.116:8080/api",
  isActive: true, assignments: [assignment],
};
const storedEvent = (assignmentsJson) => ({
  id: eventId, storeId, store: { slug: "noor", name: "Noor" },
  ...eventFields, assignmentsJson, revision: 1, isImported: false,
  syncTokenHash: null, lastAppliedRevision: 0, lastAppliedAt: null,
  createdAt: new Date("2026-10-12T12:00:00.000Z"), updatedAt: new Date("2026-10-12T12:00:00.000Z"),
});

test("assignment tokens are opaque, independently generated and stable across ordinary edits", () => {
  const first = prepareQrAssignments([assignment]);
  const token = first[0].publicToken;
  assert.match(token, /^QT-[0-9A-F]{32}$/);
  assert.equal(Object.hasOwn(assignment, "publicToken"), false, "caller-owned draft must not be mutated");
  assert.ok(!token.includes(eventId));
  assert.ok(!token.includes(assignment.publicCode));
  const secondEvent = prepareQrAssignments([assignment]);
  assert.notEqual(secondEvent[0].publicToken, token, "reused GT codes in different events need independent tokens");
  const changed = prepareQrAssignments([
    { publicCode: "GT-WXYZ-6789", tableId: null, label: null, isActive: true },
    { ...assignment, tableId: otherTableId, label: "Renamed", isActive: false },
  ], first);
  assert.equal(changed.find(row => row.publicCode === assignment.publicCode).publicToken, token);
  assert.notEqual(changed.find(row => row.publicCode !== assignment.publicCode).publicToken, token);
  assert.deepEqual(prepareQrAssignments(changed.map(({ publicToken, ...draft }) => draft), changed), changed);
  const migrated = prepareQrAssignments([assignment], [assignment]);
  assert.match(migrated[0].publicToken, /^QT-[0-9A-F]{32}$/, "saving a legacy assignment must issue a token");
});

test("event creation and editing reject caller-selected public tokens", () => {
  const supplied = { ...assignment, publicToken: "QT-0123456789ABCDEF0123456789ABCDEF" };
  assert.throws(() => qrEventCreateSchema.parse({ ...eventFields, assignments: [supplied] }));
  assert.throws(() => qrEventPatchSchema.parse({ expectedRevision: 1, assignments: [supplied] }));
  assert.deepEqual(qrEventCreateSchema.parse(eventFields).assignments, [assignment]);
});

test("new exports carry v2 tokens while untouched legacy exports remain valid v1 bundles", () => {
  const issued = prepareQrAssignments([assignment]);
  const bundle = exportQrEvent(storedEvent(issued));
  assert.equal(bundle.schemaVersion, 2);
  assert.equal(bundle.event.assignments[0].publicToken, issued[0].publicToken);
  assert.deepEqual(qrEventBundleSchema.parse(bundle), bundle);
  const missingToken = structuredClone(bundle);
  delete missingToken.event.assignments[0].publicToken;
  assert.throws(() => qrEventBundleSchema.parse(missingToken), "v2 imports must never silently regenerate a printed token");
  const malformedToken = structuredClone(bundle);
  malformedToken.event.assignments[0].publicToken = eventId;
  assert.throws(() => qrEventBundleSchema.parse(malformedToken));
  const repeatedToken = structuredClone(bundle);
  repeatedToken.event.assignments.push({ ...repeatedToken.event.assignments[0], publicCode: "GT-WXYZ-6789" });
  assert.throws(() => qrEventBundleSchema.parse(repeatedToken), "two assignments cannot share the same public token");

  const legacy = exportQrEvent(storedEvent([assignment]));
  assert.equal(legacy.schemaVersion, 1);
  assert.deepEqual(qrEventBundleSchema.parse(legacy), legacy);
  assert.equal(Object.hasOwn(legacy.event.assignments[0], "publicToken"), false);
  const mislabeled = { ...bundle, schemaVersion: 1 };
  assert.throws(() => qrEventBundleSchema.parse(mislabeled), "a token-bearing bundle cannot be mislabeled as legacy");
});

test("local import preserves public tokens exactly and accepts legacy bundles without inventing tokens", async () => {
  const savedTransaction = db.$transaction;
  const savedLocalOnly = process.env.LOCAL_ONLY;
  const rows = new Map();
  const audit = [];
  const tx = {
    store: { findUnique: async ({ where }) => where.id === storeId ? { slug: "noor", name: "Noor" } : null },
    table: { count: async ({ where }) => where.storeId === storeId ? where.id.in.length : 0 },
    qrEvent: {
      findUnique: async ({ where }) => rows.get(where.id) ?? null,
      create: async ({ data }) => {
        const row = { ...storedEvent(data.assignmentsJson), ...data };
        rows.set(row.id, row);
        return row;
      },
      updateMany: async ({ where, data }) => {
        const row = rows.get(where.id);
        if (!row || row.revision !== where.revision || !row.isImported) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
    auditLog: { create: async ({ data }) => { audit.push(data); return data; } },
  };
  db.$transaction = async callback => callback(tx);
  process.env.LOCAL_ONLY = "true";
  try {
    const bundle = exportQrEvent(storedEvent(prepareQrAssignments([assignment])));
    const token = bundle.event.assignments[0].publicToken;
    const first = await importQrEventBundle(bundle);
    assert.equal(first.unchanged, false);
    assert.equal(first.event.assignmentsJson[0].publicToken, token);
    assert.equal((await importQrEventBundle(bundle)).unchanged, true);
    const edited = structuredClone(bundle);
    edited.event.revision++;
    edited.event.assignments[0].label = "New label";
    const updated = await importQrEventBundle(edited);
    assert.equal(updated.event.assignmentsJson[0].publicToken, token);
    assert.equal(updated.event.revision, 2);
    const conflicting = structuredClone(edited);
    conflicting.event.assignments[0].publicToken = "QT-0123456789ABCDEF0123456789ABCDEF";
    await assert.rejects(() => importQrEventBundle(conflicting), /QR_EVENT_REVISION_CONTENT_CONFLICT/);
    assert.equal(rows.get(eventId).assignmentsJson[0].publicToken, token);

    const downgrade = structuredClone(edited);
    downgrade.schemaVersion = 1;
    downgrade.event.revision = 3;
    downgrade.event.assignments = downgrade.event.assignments.map(({ publicToken, ...row }) => row);
    await assert.rejects(() => importQrEventBundle(downgrade), error => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, "QR_EVENT_TOKEN_DOWNGRADE");
      return true;
    });
    assert.equal(rows.get(eventId).revision, 2, "rejected legacy import must retain the current revision");
    assert.equal(rows.get(eventId).assignmentsJson[0].publicToken, token, "printed token must survive a legacy downgrade attempt");

    // A Pi can miss the revision removing an assignment before it is re-added.
    // The newer authenticated v2 configuration must still become authoritative.
    const reissued = structuredClone(edited);
    reissued.event.revision = 4;
    reissued.event.assignments[0].publicToken = "QT-FEDCBA9876543210FEDCBA9876543210";
    const replacement = await importQrEventBundle(reissued);
    assert.equal(replacement.event.assignmentsJson[0].publicToken, reissued.event.assignments[0].publicToken);
    assert.equal(replacement.event.revision, 4);

    const legacy = exportQrEvent(storedEvent([assignment]));
    legacy.event.id = "b7a8c9d0-1234-4567-8123-123456789abc";
    const old = await importQrEventBundle(legacy);
    assert.equal(Object.hasOwn(old.event.assignmentsJson[0], "publicToken"), false);
    assert.equal((await importQrEventBundle(legacy)).unchanged, true);
    assert.equal(audit.length, 4, "only changed imports should be audited");
  } finally {
    db.$transaction = savedTransaction;
    if (savedLocalOnly === undefined) delete process.env.LOCAL_ONLY;
    else process.env.LOCAL_ONLY = savedLocalOnly;
    await db.$disconnect();
  }
});
