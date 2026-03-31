import { Pool } from "pg";
import { createClient } from "redis";
import { config } from "./config.js";

export const pg = new Pool({
  connectionString: config.pgUrl
});

export const redis = createClient({
  url: config.redisUrl
});

export async function initInfra(): Promise<void> {
  await pg.query("select 1");
  if (!redis.isOpen) {
    await redis.connect();
  }
}
