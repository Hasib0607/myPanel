import { Redis } from "ioredis";
import { env } from "../config/env.js";

export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null
});

redis.on("error", (error) => {
  if (process.env.NODE_ENV !== "test") {
    console.warn(`Redis unavailable: ${error.message}`);
  }
});
