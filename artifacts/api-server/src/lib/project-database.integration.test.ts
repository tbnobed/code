import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pool, Pool } from "@workspace/db";
import { createProjectDatabase, deleteProjectDatabase, projectDatabaseStatus, queryProjectDatabase } from "./project-database";
import { readRuntimeConfig, deleteRuntimeConfig } from "./runtime-settings";

test("real project databases: provisioning, persistence, SQL, role isolation and cleanup", { skip: process.env.FORGE_DATABASE_INTEGRATION !== "1" }, async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "forge-db-check-"));
  const one = path.join(parent, "one"), two = path.join(parent, "two");
  try {
    await fs.mkdir(one); await fs.mkdir(two);
    const first = await createProjectDatabase(one);
    const second = await createProjectDatabase(two);
    assert.ok(first.provisioned && second.provisioned);
    assert.notEqual(first.name, second.name);
    assert.equal((await createProjectDatabase(one)).name, first.name);
    await queryProjectDatabase(one, "CREATE TABLE items (id integer PRIMARY KEY, name text)");
    await queryProjectDatabase(one, "INSERT INTO items SELECT i, 'item' FROM generate_series(1,250) i");
    const rows = await queryProjectDatabase(one, "SELECT * FROM items ORDER BY id");
    assert.equal(rows.rows.length, 200); assert.equal(rows.rowCount, 250); assert.equal(rows.truncated, true);
    assert.ok((await projectDatabaseStatus(one)).tables?.some(t => t.name === "items"));
    await assert.rejects(queryProjectDatabase(two, "SELECT * FROM items"));
    await assert.rejects(queryProjectDatabase(one, "SELECT 1; SELECT 2"));
    const privileges = await queryProjectDatabase(one, "SELECT rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname=current_user");
    assert.deepEqual(privileges.rows[0], [false, false, false]);
    await assert.rejects(queryProjectDatabase(one, `SET ROLE "${second.name}"`));
    const env = (await readRuntimeConfig(one)).environment;
    assert.ok(env.DATABASE_URL);
    const cross = new URL(env.DATABASE_URL); cross.pathname = "/" + second.name;
    const forbidden = new Pool({ connectionString: cross.toString(), connectionTimeoutMillis: 5000 });
    try { await assert.rejects(forbidden.query("SELECT 1")); } finally { await forbidden.end(); }
    const encrypted = await fs.readFile(path.join(parent, ".forge-runtime/one.json"), "utf8");
    assert.ok(!encrypted.includes(env.DATABASE_URL));
    await deleteProjectDatabase(one);
    assert.equal((await projectDatabaseStatus(one)).provisioned, false);
    assert.equal((await readRuntimeConfig(one)).environment.DATABASE_URL, undefined);
  } finally {
    await deleteProjectDatabase(one);
    await deleteProjectDatabase(two);
    await deleteRuntimeConfig(one); await deleteRuntimeConfig(two);
    await fs.rm(parent, { recursive: true, force: true });
    await pool.end();
  }
});