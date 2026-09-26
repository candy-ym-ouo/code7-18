import pg from "pg";
import type { PoolClient } from "pg";
import { config } from "./config";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 8,
  idleTimeoutMillis: 30_000
});

pool.on("error", (error) => {
  console.error({ error }, "unexpected PostgreSQL pool error");
});

export async function withTransaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

