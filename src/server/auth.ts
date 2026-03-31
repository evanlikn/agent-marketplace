import { Request, Response, NextFunction } from "express";
import { redis } from "./db.js";
import { verifyAccessToken } from "./oauth.js";
import { getOAuthClient, verifyApiKey } from "./repositories.js";

const requestWindow = new Map<string, { tsSecond: number; count: number }>();

export interface CallerContext {
  callerId?: string;
  publisherId?: string;
  role: "caller" | "publisher" | "admin";
  clientId: string;
  scope: string;
  authType: "bearer" | "api_key";
  limits?: {
    monthly_quota: number;
    qps_limit: number;
    concurrent_limit: number;
  };
}

declare module "express-serve-static-core" {
  interface Request {
    callerContext?: CallerContext;
  }
}

export function requireCallerAuth(req: Request, res: Response, next: NextFunction): void {
  const apiKey = req.header("x-api-key");
  if (apiKey) {
    void handleApiKeyAuth(req, res, next, apiKey);
    return;
  }

  const authHeader = req.header("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "UNAUTHORIZED", message: "Missing Bearer token or x-api-key" });
    return;
  }
  const token = authHeader.slice("Bearer ".length);
  try {
    const claims = verifyAccessToken(token);
    if (claims.role !== "caller" && claims.role !== "admin") {
      res.status(403).json({ error: "FORBIDDEN", message: "Caller role required" });
      return;
    }
    req.callerContext = {
      callerId: claims.caller_id,
      publisherId: claims.publisher_id,
      role: claims.role,
      clientId: claims.client_id,
      scope: claims.scope,
      authType: "bearer"
    };
    void enforceCallerLimits(req, res, next);
  } catch {
    res.status(401).json({ error: "UNAUTHORIZED", message: "Invalid token" });
  }
}

async function handleApiKeyAuth(
  req: Request,
  res: Response,
  next: NextFunction,
  apiKey: string
): Promise<void> {
  const keyRecord = await verifyApiKey(apiKey);
  if (!keyRecord) {
    res.status(401).json({ error: "UNAUTHORIZED", message: "Invalid API key" });
    return;
  }
  req.callerContext = {
    callerId: keyRecord.caller_id,
    role: "caller",
    clientId: `apikey:${keyRecord.key_id}`,
    scope: keyRecord.scope,
    authType: "api_key",
    limits: {
      monthly_quota: keyRecord.monthly_quota,
      qps_limit: keyRecord.qps_limit,
      concurrent_limit: keyRecord.concurrent_limit
    }
  };
  await enforceCallerLimits(req, res, next);
}

async function enforceCallerLimits(req: Request, res: Response, next: NextFunction): Promise<void> {
  const callerId = req.callerContext?.callerId;
  const clientId = req.callerContext?.clientId;
  if (!callerId || !clientId) {
    res.status(403).json({ error: "FORBIDDEN", message: "Missing caller identity" });
    return;
  }
  let limits = req.callerContext?.limits;
  if (!limits) {
    const client = await getOAuthClient(clientId);
    if (!client) {
      res.status(401).json({ error: "UNAUTHORIZED", message: "Unknown oauth client" });
      return;
    }
    limits = {
      monthly_quota: client.monthly_quota,
      qps_limit: client.qps_limit,
      concurrent_limit: client.concurrent_limit
    };
  }

  const month = new Date().toISOString().slice(0, 7);
  const quotaKey = `quota:${callerId}:${month}`;
  const used = Number((await redis.get(quotaKey)) ?? "0");
  if (used >= limits.monthly_quota) {
    res.status(429).json({ error: "QUOTA_EXCEEDED", message: "Monthly quota exceeded" });
    return;
  }

  const second = Math.floor(Date.now() / 1000);
  const bucket = requestWindow.get(callerId);
  if (!bucket || bucket.tsSecond !== second) {
    requestWindow.set(callerId, { tsSecond: second, count: 1 });
  } else {
    if (bucket.count >= limits.qps_limit) {
      res.status(429).json({ error: "QPS_LIMITED", message: "Too many requests" });
      return;
    }
    bucket.count += 1;
  }

  const inflight = Number((await redis.get(`inflight:${callerId}`)) ?? "0");
  if (inflight >= limits.concurrent_limit) {
    res.status(429).json({ error: "CONCURRENCY_LIMITED", message: "Too many inflight requests" });
    return;
  }
  next();
}

export async function increaseInflight(callerId: string): Promise<void> {
  await redis.incr(`inflight:${callerId}`);
  await redis.expire(`inflight:${callerId}`, 120);
}

export async function decreaseInflight(callerId: string): Promise<void> {
  const key = `inflight:${callerId}`;
  const current = Number((await redis.get(key)) ?? "0");
  const next = Math.max(current - 1, 0);
  await redis.set(key, String(next), { EX: 120 });
}

export function requirePublisherAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.header("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "UNAUTHORIZED", message: "Missing Bearer token" });
    return;
  }
  const token = authHeader.slice("Bearer ".length);
  try {
    const claims = verifyAccessToken(token);
    if (claims.role !== "publisher" && claims.role !== "admin") {
      res.status(403).json({ error: "FORBIDDEN", message: "Publisher role required" });
      return;
    }
    req.callerContext = {
      callerId: claims.caller_id,
      publisherId: claims.publisher_id,
      role: claims.role,
      clientId: claims.client_id,
      scope: claims.scope,
      authType: "bearer"
    };
    next();
  } catch {
    res.status(401).json({ error: "UNAUTHORIZED", message: "Invalid token" });
  }
}
