import "dotenv/config";
import path from "path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db } from "@/db";

/** Applies pending SQL migrations. Run on every deploy (see render.yaml). */
async function main() {
  // Works from both `tsx src/db/migrate.ts` and compiled `dist/db/migrate.js`
  // because migrations are read from the project root, not next to this file.
  const folder = path.resolve(process.cwd(), "src", "db", "migrations");
  await migrate(db, { migrationsFolder: folder });
  console.log("Migrations applied.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
