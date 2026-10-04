import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { pool, Pool, Query } from "@workspace/db";
import { encryptSecret, decryptSecret } from "./crypto";
import { readRuntimeConfig, saveRuntimeConfig } from "./runtime-settings";
import { stopRuntime } from "./runtime";

type RecordData = { name: string; role: string; encryptedUrl: string };
const locks = new Map<string, Promise<unknown>>();
const file = (dir: string) => path.join(path.dirname(dir), ".forge-databases", path.basename(dir) + ".json");
const ident = (value: string) => '"' + value.replace(/"/g, '""') + '"';
async function record(dir: string): Promise<RecordData | null> {
  try { return JSON.parse(await fs.readFile(file(dir), "utf8")); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
}
export async function hasProjectDatabase(dir: string) { return Boolean(await record(dir)); }
function urlFor(r: RecordData) {
  const url = decryptSecret(r.encryptedUrl);
  if (!url) throw new Error("Cannot decrypt database credentials. Restore the original SESSION_SECRET.");
  return url;
}
function exclusive<T>(dir: string, operation: () => Promise<T>): Promise<T> {
  const next = (locks.get(dir) || Promise.resolve()).catch(() => {}).then(operation);
  locks.set(dir, next);
  void next.finally(() => { if (locks.get(dir) === next) locks.delete(dir); }).catch(() => {});
  return next;
}
export async function projectDatabaseStatus(dir: string) {
  const r = await record(dir);
  if (!r) return { provisioned: false };
  const client = new Pool({ connectionString: urlFor(r), max: 1, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
  try {
    const result = await client.query('SELECT table_schema AS schema, table_name AS name FROM information_schema.tables WHERE table_schema NOT IN (\'pg_catalog\', \'information_schema\') ORDER BY 1,2');
    return { provisioned: true, name: r.name, tables: result.rows };
  } catch {
    return { provisioned: true, name: r.name, tables: [], error: "The managed database exists but is not reachable. Check PostgreSQL availability. Database deletion remains available." };
  } finally { await client.end(); }
}
export function createProjectDatabase(dir: string) {
  return exclusive(dir, async () => {
    const existing = await record(dir);
    if (existing) {
      const current = await readRuntimeConfig(dir);
      const url = urlFor(existing);
      if (current.environment.DATABASE_URL && current.environment.DATABASE_URL !== url) throw new Error("A different DATABASE_URL is configured. Remove it before reconnecting this project's managed database.");
      await saveRuntimeConfig(dir, { ...current, environment: { DATABASE_URL: url } });
      return projectDatabaseStatus(dir);
    }
    const config = await readRuntimeConfig(dir);
    if (config.environment.DATABASE_URL) throw new Error("This project already has DATABASE_URL configured. Remove it in Runtime settings first; its existing database will not be modified.");
    const name = "forge_project_" + crypto.randomBytes(12).toString("hex");
    const role = name;
    const password = crypto.randomBytes(32).toString("hex");
    const url = new URL(process.env.DATABASE_URL!);
    url.username = role; url.password = password; url.pathname = "/" + name;
    // Do not carry platform-specific role/schema parameters into the new database.
    for (const key of ["options", "schema"]) url.searchParams.delete(key);
    const r: RecordData = { name, role, encryptedUrl: encryptSecret(url.toString()) };
    let roleCreated = false, databaseCreated = false, persisted = false;
    try {
      await pool.query(`CREATE ROLE ${ident(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT 20 PASSWORD '${password}'`);
      roleCreated = true;
      await pool.query(`CREATE DATABASE ${ident(name)} OWNER ${ident(role)}`);
      databaseCreated = true;
      await pool.query(`REVOKE ALL ON DATABASE ${ident(name)} FROM PUBLIC`);
      await fs.mkdir(path.dirname(file(dir)), { recursive: true, mode: 0o700 });
      await fs.writeFile(file(dir), JSON.stringify(r), { mode: 0o600, flag: "wx" });
      persisted = true;
      await saveRuntimeConfig(dir, { ...config, environment: { DATABASE_URL: url.toString() } });
      return await projectDatabaseStatus(dir);
    } catch (error) {
      if (!persisted) {
        if (databaseCreated) await pool.query(`DROP DATABASE ${ident(name)} WITH (FORCE)`).catch(() => {});
        if (roleCreated) await pool.query(`DROP ROLE ${ident(role)}`).catch(() => {});
      }
      // Do not expose SQL, connection strings or generated credentials.
      throw new Error(persisted
        ? "Database was created but runtime configuration or connectivity failed. The database was preserved; check server connectivity and Runtime settings."
        : "Database provisioning failed. The Forge database administrator needs permission to create databases and login roles.");
    }
  });
}
export function deleteProjectDatabase(dir: string) {
  return exclusive(dir, async () => {
    const r = await record(dir);
    if (!r) return { provisioned: false };
    if (!/^forge_project_[a-f0-9]{24}$/.test(r.name) || r.role !== r.name) throw new Error("Invalid managed database metadata.");
    await stopRuntime(dir);
    const config = await readRuntimeConfig(dir);
    await pool.query(`DROP DATABASE IF EXISTS ${ident(r.name)} WITH (FORCE)`);
    await pool.query(`DROP ROLE IF EXISTS ${ident(r.role)}`);
    if (config.environment.DATABASE_URL === urlFor(r)) await saveRuntimeConfig(dir, { ...config, environment: { DATABASE_URL: "" } });
    await fs.rm(file(dir), { force: true });
    return { provisioned: false };
  });
}
export function queryProjectDatabase(dir: string, sql: string) {
  return exclusive(dir, async () => {
    if (!sql.trim() || sql.length > 20000) throw new Error("Provide one SQL statement, up to 20,000 characters.");
    const r = await record(dir);
    if (!r) throw new Error("Create this project's database first.");
    // Do not set pg query_timeout here: pg installs a callback for that option,
    // diverting SQL errors away from our streaming Query's error event. Use
    // server statement_timeout plus the explicit promise deadline below.
    const client = new Pool({ connectionString: urlFor(r), max: 1, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
    try {
      // Extended protocol rejects multiple statements; role is never a Forge administrator.
      const connection = await client.connect();
      try {
        return await new Promise<{ columns: string[]; rows: unknown[][]; rowCount: number; command: string; truncated: boolean }>((resolve, reject) => {
          const rows: unknown[][] = [];
          let bytes = 0, truncated = false;
          const timer = setTimeout(() => reject(new Error("Query timeout")), 10000);
          const query = new Query({ text: sql, queryMode: "extended", rowMode: "array" } as any);
          query.on("row", (row: unknown[]) => {
            const size = Buffer.byteLength(JSON.stringify(row));
            if (rows.length < 200 && bytes + size < 1024 * 1024) { rows.push(row); bytes += size; }
            else truncated = true;
          });
          query.on("error", error => { clearTimeout(timer); reject(error); });
          query.on("end", (result) => {
            clearTimeout(timer);
            resolve({ columns: result.fields.map(f => f.name), rows, rowCount: result.rowCount ?? 0, command: result.command, truncated });
          });
          connection.query(query);
        });
      } finally { connection.release(true); }
    } catch (e) {
      const code = (e as { code?: string }).code || "unknown";
      throw new Error(`SQL statement failed (${/^[A-Z0-9]{5}$/.test(code) ? code : "query error"}). Check syntax, permissions, constraints and the five-second statement limit.`);
    } finally { await client.end(); }
  });
}