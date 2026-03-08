import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

export const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  lazyConnect: true,
});

redis.on("error", (err) => {
  console.error("[redis] connection error:", err.message);
});

export async function connectRedis() {
  try {
    await redis.connect();
    console.log("[redis] connected to", REDIS_URL);
  } catch (err: any) {
    console.error("[redis] failed to connect:", err.message);
    throw err;
  }
}
