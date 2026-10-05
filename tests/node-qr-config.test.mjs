import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";

process.env.DB_CONNECTION = "default";
process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:15432/garsone_test";
const { localQrPublicUrl } = await import("../dist/lib/nodeQrConfig.js");
const { localQrConfigRoutes } = await import("../dist/routes/localQrConfig.js");

test("QR destinations follow each tile's venue deployment", () => {
  const code = "GT-ABCD-2345";
  assert.equal(localQrPublicUrl(null, code), undefined);
  assert.equal(localQrPublicUrl({ venueDeployment: { target: "ONLINE", localUrl: "http://old-pi:8080" } }, code), undefined);
  assert.equal(localQrPublicUrl({ venueDeployment: { target: "PI", localUrl: "http://10.194.47.73:8080/" } }, code), "http://10.194.47.73:8080/q/GT-ABCD-2345");
  for (const localUrl of ["", "javascript:alert(1)", "http://user:password@pi:8080", "http://pi:8080/foreign", "http://pi:8080?token=private"]) {
    assert.equal(localQrPublicUrl({ venueDeployment: { target: "PI", localUrl } }, code), null);
  }
});

test("QR import requires a dedicated local secret and rejects broader venue data", async () => {
  const app = Fastify();
  await app.register(localQrConfigRoutes);
  const secret = "fixture-only-local-qr-secret-123456789";
  process.env.LOCAL_QR_SYNC_SECRET = secret;
  try {
    process.env.LOCAL_ONLY = "false";
    assert.equal((await app.inject({ method: "POST", url: "/internal/qr-config", headers: { "x-local-qr-secret": secret }, payload: {} })).statusCode, 401);
    process.env.LOCAL_ONLY = "true";
    for (const headers of [{}, { authorization: "Bearer cloud-architect-token" }, { "x-local-qr-secret": "wrong" }]) {
      assert.equal((await app.inject({ method: "POST", url: "/internal/qr-config", headers, payload: {} })).statusCode, 401);
    }
    assert.equal((await app.inject({ method: "POST", url: "/internal/qr-config", headers: { "x-local-qr-secret": secret }, payload: { profiles: [], orders: [], store: {} } })).statusCode, 400);
  } finally { await app.close(); delete process.env.LOCAL_ONLY; delete process.env.LOCAL_QR_SYNC_SECRET; }
});
