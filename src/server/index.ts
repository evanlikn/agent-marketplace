import http from "node:http";
import express from "express";
import { nanoid } from "nanoid";
import { manifestToAgentCard } from "../shared/a2a-mapper.js";
import { validateOrThrow, SchemaValidationError } from "../shared/schema.js";
import { AgentManifest, InvocationRecord, ProviderSession } from "../shared/types.js";
import { requireCallerAuth, requirePublisherAuth, increaseInflight, decreaseInflight } from "./auth.js";
import { attachProviderHub, createSessionToken, invokeProvider } from "./provider-hub.js";
import { pickBestProvider, markInvocationResult } from "./router.js";
import { config } from "./config.js";
import { initInfra, pg, redis } from "./db.js";
import {
  createApiKeyForCaller,
  createProviderSession,
  createUser,
  getCanonicalAgentId,
  getInvocationRecord,
  getListing,
  getListingByAgentNamespace,
  listListingsForPublisher,
  listPublicAgents,
  getMetricsSummary,
  saveInvocationRecord,
  seedDefaultClients,
  listApiKeysForCaller,
  upsertListing,
  updateProviderSession,
  verifyOAuthClient,
  verifyUserPassword,
  recordSettlementEntries,
  runSettlementForPublisher
} from "./repositories.js";
import {
  signAccessToken,
  createDeviceCode,
  issueClientCredentialsToken,
  issueFromRefreshToken,
  pollDeviceCodeToken,
  approveDeviceCode
} from "./oauth.js";

const app = express();
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", config.corsAllowOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: "1mb" }));

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

app.get("/readyz", async (_req, res) => {
  try {
    await Promise.all([pg.query("select 1"), redis.ping()]);
    res.json({ ready: true, ts: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ ready: false, error: String(err) });
  }
});

app.post("/oauth/token", async (req, res) => {
  try {
    const grantType = String(req.body.grant_type ?? "");
    if (grantType === "client_credentials") {
      const client = await verifyOAuthClient(String(req.body.client_id ?? ""), String(req.body.client_secret ?? ""));
      if (!client) {
        res.status(401).json({ error: "invalid_client" });
        return;
      }
      const token = await issueClientCredentialsToken(client, String(req.body.scope ?? "invoke"));
      res.json(token);
      return;
    }
    if (grantType === "urn:ietf:params:oauth:grant-type:device_code") {
      const result = await pollDeviceCodeToken({
        client_id: String(req.body.client_id ?? ""),
        device_code: String(req.body.device_code ?? "")
      });
      if (result.pending) {
        res.status(428).json({ error: "authorization_pending" });
        return;
      }
      const refreshToken = `rt_${nanoid(16)}`;
      await redis.setEx(
        `oauth:refresh:${refreshToken}`,
        config.refreshTokenTtlSec,
        JSON.stringify({
          claims: result.claims
        })
      );
      res.json({
        access_token: result.token,
        token_type: "Bearer",
        expires_in: config.accessTokenTtlSec,
        refresh_token: refreshToken
      });
      return;
    }
    if (grantType === "refresh_token") {
      const token = await issueFromRefreshToken(String(req.body.refresh_token ?? ""));
      res.json(token);
      return;
    }
    res.status(400).json({ error: "unsupported_grant_type" });
  } catch (err) {
    res.status(400).json({ error: "invalid_grant", message: String(err) });
  }
});

app.post("/oauth/device/code", async (req, res) => {
  const client = await verifyOAuthClient(String(req.body.client_id ?? ""), String(req.body.client_secret ?? ""));
  if (!client) {
    res.status(401).json({ error: "invalid_client" });
    return;
  }
  const data = await createDeviceCode({
    client_id: client.client_id,
    scope: String(req.body.scope ?? "publish")
  });
  res.json(data);
});

app.post("/v1/oauth/device/approve", requireCallerAuth, async (req, res) => {
  const ctx = req.callerContext;
  const subject = ctx?.publisherId ?? ctx?.callerId;
  if (!subject) {
    res.status(403).json({ error: "NO_PUBLISHER_IDENTITY" });
    return;
  }
  const userCode = String(req.body.user_code ?? "").trim();
  if (!userCode) {
    res.status(400).json({ error: "INVALID_USER_CODE" });
    return;
  }
  const ok = await approveDeviceCode(userCode, subject);
  if (!ok) {
    res.status(400).json({ error: "invalid_user_code" });
    return;
  }
  res.json({ ok: true, subject });
});

app.post("/oauth/device/approve", async (req, res) => {
  const ok = await approveDeviceCode(String(req.body.user_code ?? ""), String(req.body.subject ?? "publisher-demo"));
  if (!ok) {
    res.status(400).json({ error: "invalid_user_code" });
    return;
  }
  res.json({ ok: true });
});

app.post("/v1/auth/register", async (req, res) => {
  try {
    const email = String(req.body.email ?? "").trim().toLowerCase();
    const password = String(req.body.password ?? "");
    const displayName = String(req.body.display_name ?? "").trim();
    if (!email || !password || !displayName) {
      res.status(400).json({ error: "INVALID_INPUT", message: "email/password/display_name are required" });
      return;
    }
    if (password.length < 8) {
      res.status(400).json({ error: "WEAK_PASSWORD", message: "password must be at least 8 chars" });
      return;
    }
    const user = await createUser({
      email,
      password,
      display_name: displayName
    });
    const apiKey = await createApiKeyForCaller({ caller_id: user.user.caller_id });
    const accessToken = signAccessToken({
      sub: user.user.user_id,
      role: "publisher",
      caller_id: user.user.caller_id,
      publisher_id: user.user.caller_id,
      client_id: user.user.oauth_client_id,
      scope: "invoke"
    });
    res.json({
      user: {
        user_id: user.user.user_id,
        email: user.user.email,
        display_name: user.user.display_name,
        caller_id: user.user.caller_id
      },
      access_token: accessToken,
      api_key: apiKey.api_key,
      api_key_id: apiKey.key_id
    });
  } catch (err) {
    const msg = String(err);
    if (msg.includes("duplicate key value")) {
      res.status(409).json({ error: "EMAIL_ALREADY_EXISTS" });
      return;
    }
    res.status(500).json({ error: "INTERNAL_ERROR", message: msg });
  }
});

app.post("/v1/auth/login", async (req, res) => {
  try {
    const email = String(req.body.email ?? "").trim().toLowerCase();
    const password = String(req.body.password ?? "");
    if (!email || !password) {
      res.status(400).json({ error: "INVALID_INPUT", message: "email/password are required" });
      return;
    }
    const user = await verifyUserPassword(email, password);
    if (!user) {
      res.status(401).json({ error: "INVALID_CREDENTIALS" });
      return;
    }

    const apiKey = await createApiKeyForCaller({ caller_id: user.caller_id });
    const accessToken = signAccessToken({
      sub: user.user_id,
      role: "publisher",
      caller_id: user.caller_id,
      publisher_id: user.caller_id,
      client_id: user.oauth_client_id,
      scope: "invoke"
    });
    res.json({
      user: {
        user_id: user.user_id,
        email: user.email,
        display_name: user.display_name,
        caller_id: user.caller_id
      },
      access_token: accessToken,
      api_key: apiKey.api_key,
      api_key_id: apiKey.key_id
    });
  } catch (err) {
    res.status(500).json({ error: "INTERNAL_ERROR", message: String(err) });
  }
});

app.get("/v1/auth/me", requireCallerAuth, async (req, res) => {
  const callerId = req.callerContext?.callerId;
  if (!callerId) {
    res.status(403).json({ error: "FORBIDDEN" });
    return;
  }
  const keys = await listApiKeysForCaller(callerId);
  res.json({
    caller_id: callerId,
    auth_type: req.callerContext?.authType,
    keys
  });
});

app.post("/v1/auth/api-key/create", requireCallerAuth, async (req, res) => {
  const callerId = req.callerContext?.callerId;
  if (!callerId) {
    res.status(403).json({ error: "FORBIDDEN" });
    return;
  }
  const created = await createApiKeyForCaller({ caller_id: callerId });
  res.json(created);
});

app.post("/v1/agents/publish", requirePublisherAuth, async (req, res) => {
  try {
    const manifest = validateOrThrow<AgentManifest>("agentManifest", req.body.manifest);
    const publisherId = req.callerContext?.publisherId ?? manifest.publisher?.publisher_id;
    if (!publisherId) {
      res.status(400).json({ error: "INVALID_PUBLISHER" });
      return;
    }
    const listing = await upsertListing(manifest, publisherId);
    res.json({
      listing_id: listing.listing_id,
      canonical_agent_id: getCanonicalAgentId(listing.publisher_id, listing.manifest.agent_id),
      status: "upserted"
    });
  } catch (err) {
    if (err instanceof SchemaValidationError) {
      res.status(400).json({ error: err.code, message: err.message, details: err.details });
      return;
    }
    res.status(500).json({ error: "INTERNAL_ERROR", message: String(err) });
  }
});

app.get("/v1/agents", async (req, res) => {
  const page = Math.max(Number(req.query.page ?? "1"), 1);
  const pageSize = Math.min(Math.max(Number(req.query.page_size ?? "20"), 1), 100);
  const q = req.query.q ? String(req.query.q) : undefined;
  const visibility = req.query.visibility ? String(req.query.visibility) : "public";
  if (!["public", "unlisted", "private"].includes(visibility)) {
    res.status(400).json({ error: "INVALID_VISIBILITY" });
    return;
  }

  const result = await listPublicAgents({
    q,
    page,
    pageSize,
    visibility: visibility as "public" | "unlisted" | "private"
  });
  res.json(result);
});

app.get("/v1/agents/resolve/:publisherId/:agentId", async (req, res) => {
  const publisherId = String(req.params.publisherId ?? "");
  const agentId = String(req.params.agentId ?? "");
  const listing = await getListingByAgentNamespace(publisherId, agentId);
  if (!listing) {
    res.status(404).json({ error: "REMOTE_AGENT_NOT_FOUND" });
    return;
  }
  res.json({
    canonical_agent_id: getCanonicalAgentId(publisherId, agentId),
    listing_id: listing.listing_id,
    publisher_id: listing.publisher_id,
    agent_id: listing.manifest.agent_id,
    visibility: listing.manifest.visibility ?? "private"
  });
});

app.get("/v1/providers/listings/mine", requirePublisherAuth, async (req, res) => {
  const publisherId = req.callerContext?.publisherId;
  if (!publisherId) {
    res.status(403).json({ error: "FORBIDDEN" });
    return;
  }
  const items = await listListingsForPublisher(publisherId);
  res.json({
    publisher_id: publisherId,
    items
  });
});

app.post("/v1/providers/session/open", requirePublisherAuth, async (req, res) => {
  const listingId = String(req.body.listing_id ?? "");
  const publisherId = req.callerContext?.publisherId ?? "";
  const maxConcurrency = Number(req.body.max_concurrency ?? 1);
  if (!listingId || !publisherId) {
    res.status(400).json({ error: "INVALID_INPUT", message: "listing_id and publisher_id are required" });
    return;
  }
  const listing = await getListing(listingId);
  if (!listing || listing.publisher_id !== publisherId) {
    res.status(404).json({ error: "LISTING_NOT_FOUND" });
    return;
  }

  const session: ProviderSession = await createProviderSession({
    listing_id: listingId,
    publisher_id: publisherId,
    max_concurrency: maxConcurrency,
    region_hint: req.body.region_hint ? String(req.body.region_hint) : undefined
  });
  validateOrThrow<ProviderSession>("providerEndpoint", session);

  res.json({
    session_id: session.session_id,
    session_token: createSessionToken(session),
    tunnel_url: `${config.gatewayBaseUrl}/v1/providers/tunnel`
  });
});

app.post("/v1/providers/session/open/by-agent/:agentId", requirePublisherAuth, async (req, res) => {
  const publisherId = req.callerContext?.publisherId ?? "";
  const agentId = String(req.params.agentId ?? "");
  const maxConcurrency = Number(req.body.max_concurrency ?? 1);
  if (!publisherId || !agentId) {
    res.status(400).json({ error: "INVALID_INPUT", message: "publisher and agent_id are required" });
    return;
  }
  const listing = await getListingByAgentNamespace(publisherId, agentId);
  if (!listing) {
    res.status(404).json({ error: "AGENT_NOT_PUBLISHED" });
    return;
  }
  const session: ProviderSession = await createProviderSession({
    listing_id: listing.listing_id,
    publisher_id: publisherId,
    max_concurrency: maxConcurrency,
    region_hint: req.body.region_hint ? String(req.body.region_hint) : undefined
  });
  validateOrThrow<ProviderSession>("providerEndpoint", session);
  res.json({
    listing_id: listing.listing_id,
    agent_id: listing.manifest.agent_id,
    session_id: session.session_id,
    session_token: createSessionToken(session),
    tunnel_url: `${config.gatewayBaseUrl}/v1/providers/tunnel`
  });
});

app.post("/v1/providers/session/heartbeat", async (req, res) => {
  const sessionId = String(req.body.session_id ?? "");
  const session = await updateProviderSession(sessionId, {
    status: "online",
    current_concurrency: Number(req.body.current_concurrency ?? 0),
    latency_ms: Number(req.body.latency_ms ?? 0),
    success_rate_1m: Number(req.body.success_rate_1m ?? 1)
  });
  if (!session) {
    res.status(404).json({ error: "SESSION_NOT_FOUND" });
    return;
  }
  res.json({ ok: true });
});

app.post("/v1/providers/session/close", async (req, res) => {
  const sessionId = String(req.body.session_id ?? "");
  const session = await updateProviderSession(sessionId, { status: "offline" });
  if (!session) {
    res.status(404).json({ error: "SESSION_NOT_FOUND" });
    return;
  }
  res.json({ ok: true });
});

app.get("/v1/a2a/agent-card/:listingId", async (req, res) => {
  const listing = await getListing(req.params.listingId);
  if (!listing) {
    res.status(404).json({ error: "LISTING_NOT_FOUND" });
    return;
  }
  const card = manifestToAgentCard(listing.manifest, {
    listingId: listing.listing_id,
    publisherId: listing.publisher_id,
    gatewayBaseUrl: config.gatewayBaseUrl
  });
  res.json(card);
});

app.get("/.well-known/agent-card.json", async (req, res) => {
  const listingId = String(req.query.listing_id ?? "");
  if (!listingId) {
    res.status(400).json({ error: "MISSING_LISTING_ID", message: "use ?listing_id=..." });
    return;
  }
  const listing = await getListing(listingId);
  if (!listing) {
    res.status(404).json({ error: "LISTING_NOT_FOUND" });
    return;
  }
  const card = manifestToAgentCard(listing.manifest, {
    listingId: listing.listing_id,
    publisherId: listing.publisher_id,
    gatewayBaseUrl: config.gatewayBaseUrl
  });
  res.setHeader("Cache-Control", "public, max-age=60");
  res.json(card);
});

async function handleInvoke(
  req: express.Request,
  res: express.Response,
  listingOverride?: {
    listing_id: string;
    publisher_id: string;
    manifest: AgentManifest;
  }
): Promise<void> {
  const listingId = listingOverride?.listing_id ?? req.params.listingId;
  const listing = listingOverride ?? (await getListing(listingId));
  if (!listing) {
    res.status(404).json({ error: "LISTING_NOT_FOUND" });
    return;
  }
  const callerId = req.callerContext?.callerId;
  if (!callerId) {
    res.status(403).json({ error: "FORBIDDEN", message: "caller identity missing" });
    return;
  }
  const provider = await pickBestProvider(listingId);
  if (!provider) {
    res.status(503).json({ error: "NO_PROVIDER_AVAILABLE" });
    return;
  }

  const requestId = `req_${nanoid(12)}`;
  const startedAt = Date.now();
  const timeoutMs = listing.manifest.routing_hints?.timeout_ms ?? 30_000;
  const record: InvocationRecord = {
    request_id: requestId,
    caller_id: callerId,
    listing_id: listingId,
    provider_session_id: provider.session_id,
    status: "running",
    started_at: new Date().toISOString()
  };
  await saveInvocationRecord(record);
  await updateProviderSession(provider.session_id, {
    current_concurrency: provider.current_concurrency + 1
  });
  await increaseInflight(callerId);

  const wantsStream = req.query.stream === "1" || req.header("accept")?.includes("text/event-stream");
  if (wantsStream) {
    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-cache");
    res.setHeader("connection", "keep-alive");
  }
  const chunks: string[] = [];

  try {
    const result = await invokeProvider(
      provider.session_id,
      {
        request_id: requestId,
        listing_id: listingId,
        input: req.body.input
      },
      timeoutMs,
      (chunk) => {
        chunks.push(chunk);
        if (wantsStream) {
          res.write(`event: invoke.chunk\n`);
          res.write(`data: ${JSON.stringify({ request_id: requestId, chunk })}\n\n`);
        }
      }
    );
    const latency = Date.now() - startedAt;
    const unitPrice = listing.manifest.pricing?.unit_price ?? 0;
    const done: InvocationRecord = validateOrThrow<InvocationRecord>("invocationRecord", {
      ...record,
      status: "succeeded",
      latency_ms: latency,
      token_usage: result.token_usage,
      cost: unitPrice,
      finished_at: new Date().toISOString()
    });
    await saveInvocationRecord(done);
    await markInvocationResult(provider.session_id, true);
    await redis.incr(`quota:${callerId}:${new Date().toISOString().slice(0, 7)}`);
    await redis.expire(`quota:${callerId}:${new Date().toISOString().slice(0, 7)}`, 31 * 24 * 3600);
    await recordSettlementEntries({
      request_id: requestId,
      caller_id: callerId,
      publisher_id: listing.publisher_id,
      amount: unitPrice,
      currency: listing.manifest.pricing?.currency ?? "USD"
    });
    if (wantsStream) {
      res.write(`event: invoke.end\n`);
      res.write(
        `data: ${JSON.stringify({ request_id: requestId, output: result.output, token_usage: result.token_usage, cost: unitPrice })}\n\n`
      );
      res.end();
    } else {
      res.json({ request_id: requestId, output: result.output || chunks.join(""), token_usage: result.token_usage, cost: unitPrice });
    }
  } catch (err) {
    const failed: InvocationRecord = {
      ...record,
      status: "failed",
      error_code: "PROVIDER_ERROR",
      finished_at: new Date().toISOString()
    };
    await saveInvocationRecord(failed);
    await markInvocationResult(provider.session_id, false);
    if (wantsStream) {
      res.write(`event: invoke.error\n`);
      res.write(`data: ${JSON.stringify({ request_id: requestId, error: "PROVIDER_ERROR", message: String(err) })}\n\n`);
      res.end();
    } else {
      res.status(502).json({ error: "PROVIDER_ERROR", message: String(err) });
    }
  } finally {
    await updateProviderSession(provider.session_id, {
      current_concurrency: Math.max(provider.current_concurrency - 1, 0)
    });
    await decreaseInflight(callerId);
  }
}

app.post("/v1/invoke/:listingId", requireCallerAuth, async (req, res) => {
  await handleInvoke(req, res);
});

app.post("/v1/invoke/by-agent/:publisherId/:agentId", requireCallerAuth, async (req, res) => {
  const publisherId = String(req.params.publisherId ?? "");
  const agentId = String(req.params.agentId ?? "");
  const listing = await getListingByAgentNamespace(publisherId, agentId);
  if (!listing) {
    res.status(404).json({ error: "REMOTE_AGENT_NOT_FOUND" });
    return;
  }
  if (listing.manifest.visibility === "private") {
    res.status(403).json({ error: "REMOTE_AGENT_NOT_VISIBLE" });
    return;
  }
  await handleInvoke(req, res, listing);
});

app.post("/v1/a2a/invoke/:listingId", requireCallerAuth, async (req, res) => {
  await handleInvoke(req, res);
});

app.post("/v1/a2a/invoke/by-agent/:publisherId/:agentId", requireCallerAuth, async (req, res) => {
  const publisherId = String(req.params.publisherId ?? "");
  const agentId = String(req.params.agentId ?? "");
  const listing = await getListingByAgentNamespace(publisherId, agentId);
  if (!listing) {
    res.status(404).json({ error: "REMOTE_AGENT_NOT_FOUND" });
    return;
  }
  if (listing.manifest.visibility === "private") {
    res.status(403).json({ error: "REMOTE_AGENT_NOT_VISIBLE" });
    return;
  }
  await handleInvoke(req, res, listing);
});

app.get("/v1/invocations/:requestId", async (_req, res) => {
  const record = await getInvocationRecord(_req.params.requestId);
  if (!record) {
    res.status(404).json({ error: "REQUEST_NOT_FOUND" });
    return;
  }
  res.json(record);
});

app.get("/v1/metrics/summary", async (_req, res) => {
  res.json(await getMetricsSummary());
});

app.post("/v1/settlements/run", requirePublisherAuth, async (req, res) => {
  const publisherId = req.callerContext?.publisherId;
  if (!publisherId) {
    res.status(400).json({ error: "INVALID_PUBLISHER" });
    return;
  }
  const periodStart = String(req.body.period_start ?? new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString());
  const periodEnd = String(req.body.period_end ?? new Date().toISOString());
  const settlement = await runSettlementForPublisher({
    publisher_id: publisherId,
    period_start: periodStart,
    period_end: periodEnd
  });
  res.json(settlement);
});

const server = http.createServer(app);
attachProviderHub(server);
void (async () => {
  await initInfra();
  await seedDefaultClients();
  server.listen(config.port, () => {
    console.log(`market server listening at ${config.gatewayBaseUrl}`);
  });
})();

async function shutdown(): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  if (redis.isOpen) {
    await redis.quit();
  }
  await pg.end();
}

process.on("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});
