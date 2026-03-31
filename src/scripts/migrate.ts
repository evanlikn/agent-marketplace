import fs from "node:fs/promises";
import path from "node:path";
import { pg } from "../server/db.js";

async function main(): Promise<void> {
  const migrationDir = path.resolve("migrations");
  const files = (await fs.readdir(migrationDir))
    .filter((f) => f.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b));

  await pg.query(`
    create table if not exists schema_migrations (
      id text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  for (const file of files) {
    const id = file;
    const already = await pg.query("select 1 from schema_migrations where id = $1", [id]);
    if (already.rowCount && already.rowCount > 0) continue;
    const sql = await fs.readFile(path.join(migrationDir, file), "utf8");
    await pg.query("begin");
    try {
      await pg.query(sql);
      await pg.query("insert into schema_migrations(id) values($1)", [id]);
      await pg.query("commit");
      console.log(`applied ${id}`);
    } catch (err) {
      await pg.query("rollback");
      throw err;
    }
  }
  await pg.end();
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
