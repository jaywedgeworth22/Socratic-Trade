import "server-only";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getDb } from "../db";
import * as schema from "./schema";

// We lazily instantiate the Drizzle client to ensure it wraps the correctly
// configured connection from getDb(), which sets up WAL mode, busy_timeout, etc.
let drizzleDb: ReturnType<typeof drizzle> | undefined;

export function getDrizzle() {
  if (drizzleDb) return drizzleDb;
  drizzleDb = drizzle(getDb(), { schema });
  return drizzleDb;
}

// Test-only: drop the cached Drizzle wrapper so the next getDrizzle() call rebuilds
// it around the freshly opened SQLite connection (paired with resetDbForTesting — see
// src/lib/db.ts). Without this, a test that resets the underlying db between cases
// would keep using a Drizzle client bound to the now-closed Database handle and
// crash with "The database connection is not open" on its first .prepare().
export function resetDrizzleForTesting(): void {
  drizzleDb = undefined;
}
