import "dotenv/config";

export const config = {
  port: Number(process.env.PORT ?? "8080"),
  gatewayBaseUrl: process.env.GATEWAY_BASE_URL ?? "http://localhost:8080",
  corsAllowOrigin: process.env.CORS_ALLOW_ORIGIN ?? "http://localhost:3000",
  pgUrl: process.env.POSTGRES_URL ?? "postgres://postgres:postgres@localhost:5432/openclaw",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  jwtIssuer: process.env.JWT_ISSUER ?? "openclaw-market",
  jwtAudience: process.env.JWT_AUDIENCE ?? "openclaw-api",
  jwtSecret: process.env.JWT_SECRET ?? "dev-secret-change-me",
  accessTokenTtlSec: Number(process.env.ACCESS_TOKEN_TTL_SEC ?? "3600"),
  refreshTokenTtlSec: Number(process.env.REFRESH_TOKEN_TTL_SEC ?? "2592000")
};
