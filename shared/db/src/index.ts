import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export * from "./schema";

export function createDb(connectionString: string) {
  // postgres-js defaults to 10 per pool. One API process is fine with that; a
  // test run is not, since every file opens its own pools against one server.
  const max = Number(process.env.DB_POOL_MAX ?? 10);
  const client = postgres(connectionString, { max });
  return drizzle(client, { schema });
}

export type Db = ReturnType<typeof createDb>;
