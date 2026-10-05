import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

// This runner owns exactly one disposable Docker container. All DB traffic is
// loopback-only, and the database is removed even when a regression test fails.
const container = `garsone-reliability-${randomUUID()}`;
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error || result.status !== 0) throw new Error(`${command} ${args[0]} failed: ${result.error?.message || result.stderr || result.stdout}`);
  return result.stdout?.trim() || "";
}
let created = false;
try {
  run("docker", ["run", "--detach", "--rm", "--name", container, "--publish", "127.0.0.1::5432",
    "--env", "POSTGRES_PASSWORD=reliability-test-only", "--env", "POSTGRES_DB=garsone_reliability_test", "postgres:16-alpine"]);
  created = true;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (spawnSync("docker", ["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "garsone_reliability_test"], { stdio: "ignore" }).status === 0) { ready = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  if (!ready) throw new Error("Disposable Postgres did not become ready");
  const port = run("docker", ["port", container, "5432"]).split(":").at(-1);
  if (!/^\d+$/.test(port || "")) throw new Error("Invalid loopback test DB port");
  const databaseUrl = `postgresql://postgres:reliability-test-only@127.0.0.1:${port}/garsone_reliability_test?connection_limit=8`;
  const env = { ...process.env, DATABASE_URL: databaseUrl, DIRECT_URL: databaseUrl, DB_CONNECTION: "default", ORDER_RELIABILITY_TEST_DATABASE_URL: databaseUrl };
  // The production entrypoint's additive bootstrap must also allow an empty DB.
  run(process.execPath, ["dist/db/ensureOrderReliabilitySchema.js"], { env, stdio: "inherit" });
  run(process.execPath, ["dist/db/ensureDiningBillingSchema.js"], { env, stdio: "inherit" });
  run(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate"], { env, stdio: "inherit" });
  run(process.execPath, ["--test", "tests/local-menu.integration.test.mjs"], { env, stdio: "inherit" });
  run(process.execPath, ["--test", "tests/order-reliability.integration.test.mjs"], { env, stdio: "inherit" });
  run(process.execPath, ["--test", "tests/local-operations.integration.test.mjs"], { env, stdio: "inherit" });
  run(process.execPath, ["--test", "tests/dining-billing.integration.test.mjs"], { env, stdio: "inherit" });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (created) spawnSync("docker", ["rm", "--force", container], { stdio: "ignore" });
}
