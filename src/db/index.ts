import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { env } from "@/lib/env";
import * as schema from "./schema";

/**
 * A single pooled connection, reused across hot-reloads in dev so we don't
 * exhaust Postgres connections. Pool size is deliberately modest — this
 * app targets ~100-200 concurrent users, not thousands — and should sit
 * behind PgBouncer in production per ARCHITECTURE.md.
 */
declare global {
  // eslint-disable-next-line no-var
  var __pgPool: Pool | undefined;
}

function useSsl(url: string): boolean {
  if (env.DATABASE_SSL) return env.DATABASE_SSL === "true";
  try {
    const host = new URL(url).hostname;
    // Render internal hostnames look like "dpg-xxxx-a" (no dots); external have ".render.com".
    return host.includes(".") && host !== "localhost" && host !== "127.0.0.1";
  } catch {
    return false;
  }
}

const pool =
  global.__pgPool ??
  new Pool({
    connectionString: env.DATABASE_URL,
    max: 20,
    // Render's *external* Postgres URL requires TLS (the internal one doesn't).
    // Auto-enabled for non-local hosts; override with DATABASE_SSL=true|false.
    ssl: useSsl(env.DATABASE_URL) ? { rejectUnauthorized: false } : undefined,
  });

if (process.env.NODE_ENV !== "production") {
  global.__pgPool = pool;
}

export const db = drizzle(pool, { schema });
