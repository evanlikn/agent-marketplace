import { nanoid } from "nanoid";
import { createHash, timingSafeEqual } from "node:crypto";
import { pg, redis } from "./db.js";
import { AgentManifest, InvocationRecord, Listing, ProviderSession } from "../shared/types.js";

function nowIso(): string {
  return new Date().toISOString();
}

function toRedisHash(input: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined || v === null) continue;
    out[k] = String(v);
  }
  return out;
}

export async function seedDefaultClients(): Promise<void> {
  await pg.query(
    `
    insert into oauth_clients(client_id, client_secret_hash, role, caller_id, publisher_id, monthly_quota, qps_limit, concurrent_limit)
    values
      ('caller-dev', $1, 'caller', 'caller-demo', null, 100000, 50, 20),
      ('publisher-dev', $2, 'publisher', null, 'publisher-demo', 100000, 50, 20)
    on conflict (client_id) do nothing
  `,
    [sha256("caller-dev-secret"), sha256("publisher-dev-secret")]
  );
  await pg.query(
    `
    insert into api_keys(key_id, key_hash, caller_id, scope, monthly_quota, qps_limit, concurrent_limit, status)
    values
      ('caller-public-dev', $1, 'caller-demo', 'invoke', 100000, 50, 20, 'active')
    on conflict (key_id) do nothing
  `,
    [sha256("caller-public-dev-key")]
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function verifySecret(input: string, digest: string): boolean {
  const left = Buffer.from(sha256(input), "utf8");
  const right = Buffer.from(digest, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export interface OAuthClientRecord {
  client_id: string;
  client_secret_hash: string;
  role: "caller" | "publisher" | "admin";
  caller_id: string | null;
  publisher_id: string | null;
  monthly_quota: number;
  qps_limit: number;
  concurrent_limit: number;
}

export interface ApiKeyRecord {
  key_id: string;
  key_hash: string;
  caller_id: string;
  scope: string;
  monthly_quota: number;
  qps_limit: number;
  concurrent_limit: number;
  status: "active" | "revoked";
}

export interface PublicAgentListItem {
  canonical_agent_id: string;
  publisher_id: string;
  agent_id: string;
  display_name: string;
  description: string;
  skills: Array<{ id: string; name: string; tags: string[] }>;
  visibility: "public" | "unlisted" | "private";
  updated_at: string;
}

export interface PublisherListingItem {
  listing_id: string;
  publisher_id: string;
  agent_id: string;
  display_name: string;
  visibility: "public" | "unlisted" | "private";
  updated_at: string;
}

export interface UserRecord {
  user_id: string;
  email: string;
  password_hash: string;
  display_name: string;
  caller_id: string;
  oauth_client_id: string;
}

export async function getOAuthClient(clientId: string): Promise<OAuthClientRecord | null> {
  const result = await pg.query<OAuthClientRecord>("select * from oauth_clients where client_id = $1", [clientId]);
  return result.rows[0] ?? null;
}

export async function verifyOAuthClient(clientId: string, clientSecret: string): Promise<OAuthClientRecord | null> {
  const client = await getOAuthClient(clientId);
  if (!client) return null;
  if (!verifySecret(clientSecret, client.client_secret_hash)) return null;
  return client;
}

export async function verifyApiKey(apiKey: string): Promise<ApiKeyRecord | null> {
  const keyHash = sha256(apiKey);
  const result = await pg.query<ApiKeyRecord>(
    `
    select key_id, key_hash, caller_id, scope, monthly_quota, qps_limit, concurrent_limit, status
    from api_keys
    where key_hash = $1
      and status = 'active'
  `,
    [keyHash]
  );
  return result.rows[0] ?? null;
}

export async function createUser(input: {
  email: string;
  password: string;
  display_name: string;
}): Promise<{
  user: Omit<UserRecord, "password_hash">;
}> {
  const userId = `usr_${nanoid(10)}`;
  const callerId = `caller_${nanoid(10)}`;
  const oauthClientId = `caller-user-${userId}`;
  const oauthClientSecret = `sec_${nanoid(24)}`;
  const passwordHash = sha256(input.password);

  await pg.query("begin");
  try {
    await pg.query(
      `
      insert into oauth_clients(client_id, client_secret_hash, role, caller_id, monthly_quota, qps_limit, concurrent_limit)
      values($1, $2, 'caller', $3, 100000, 50, 20)
    `,
      [oauthClientId, sha256(oauthClientSecret), callerId]
    );
    const result = await pg.query<Omit<UserRecord, "password_hash">>(
      `
      insert into users(user_id, email, password_hash, display_name, caller_id, oauth_client_id)
      values($1, $2, $3, $4, $5, $6)
      returning user_id, email, display_name, caller_id, oauth_client_id
    `,
      [userId, input.email.toLowerCase(), passwordHash, input.display_name, callerId, oauthClientId]
    );
    await pg.query("commit");
    return { user: result.rows[0] };
  } catch (err) {
    await pg.query("rollback");
    throw err;
  }
}

export async function findUserByEmail(email: string): Promise<UserRecord | null> {
  const result = await pg.query<UserRecord>(
    `
    select user_id, email, password_hash, display_name, caller_id, oauth_client_id
    from users
    where email = $1
  `,
    [email.toLowerCase()]
  );
  return result.rows[0] ?? null;
}

export async function verifyUserPassword(email: string, password: string): Promise<UserRecord | null> {
  const user = await findUserByEmail(email);
  if (!user) return null;
  if (!verifySecret(password, user.password_hash)) return null;
  return user;
}

export async function createApiKeyForCaller(input: {
  caller_id: string;
  scope?: string;
  monthly_quota?: number;
  qps_limit?: number;
  concurrent_limit?: number;
}): Promise<{ key_id: string; api_key: string }> {
  const keyId = `key_${nanoid(10)}`;
  const rawApiKey = `oak_${nanoid(40)}`;
  await pg.query(
    `
    insert into api_keys(key_id, key_hash, caller_id, scope, monthly_quota, qps_limit, concurrent_limit, status)
    values($1, $2, $3, $4, $5, $6, $7, 'active')
  `,
    [
      keyId,
      sha256(rawApiKey),
      input.caller_id,
      input.scope ?? "invoke",
      input.monthly_quota ?? 100000,
      input.qps_limit ?? 50,
      input.concurrent_limit ?? 20
    ]
  );
  return { key_id: keyId, api_key: rawApiKey };
}

export async function listApiKeysForCaller(callerId: string): Promise<Array<{ key_id: string; scope: string; status: string; created_at: string }>> {
  const result = await pg.query<{ key_id: string; scope: string; status: string; created_at: string }>(
    `
    select key_id, scope, status, created_at
    from api_keys
    where caller_id = $1
    order by created_at desc
  `,
    [callerId]
  );
  return result.rows.map((row) => ({
    ...row,
    created_at: new Date(row.created_at).toISOString()
  }));
}

export async function upsertListing(manifest: AgentManifest, publisherId: string): Promise<Listing> {
  const existing = await pg.query<{ listing_id: string; created_at: string }>(
    "select listing_id, created_at from listings where publisher_id = $1 and agent_id = $2",
    [publisherId, manifest.agent_id]
  );
  const listingId = existing.rows[0]?.listing_id ?? `lst_${nanoid(10)}`;
  const result = await pg.query<Listing>(
    `
    insert into listings(listing_id, publisher_id, agent_id, manifest, created_at, updated_at)
    values($1, $2, $3, $4::jsonb, now(), now())
    on conflict (listing_id) do update
      set manifest = excluded.manifest,
          updated_at = now()
    returning listing_id, publisher_id, manifest, created_at, updated_at
  `,
    [listingId, publisherId, manifest.agent_id, JSON.stringify(manifest)]
  );
  const row = result.rows[0];
  return {
    listing_id: row.listing_id,
    publisher_id: row.publisher_id,
    manifest: row.manifest,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString()
  };
}

export async function getListing(listingId: string): Promise<Listing | null> {
  const result = await pg.query<Listing>(
    "select listing_id, publisher_id, manifest, created_at, updated_at from listings where listing_id = $1",
    [listingId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    listing_id: row.listing_id,
    publisher_id: row.publisher_id,
    manifest: row.manifest,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString()
  };
}

export function getCanonicalAgentId(publisherId: string, agentId: string): string {
  return `${publisherId}/${agentId}`;
}

export async function listPublicAgents(input: {
  q?: string;
  page: number;
  pageSize: number;
  visibility?: "public" | "unlisted" | "private";
}): Promise<{ items: PublicAgentListItem[]; total: number; page: number; page_size: number }> {
  const offset = (input.page - 1) * input.pageSize;
  const visibility = input.visibility ?? "public";
  const q = (input.q ?? "").trim();
  const hasQuery = q.length > 0;

  const whereSql = hasQuery
    ? `
      where coalesce(manifest->>'visibility', 'private') = $1
        and (
          manifest->>'display_name' ilike $2
          or manifest->>'description' ilike $2
          or agent_id ilike $2
          or publisher_id ilike $2
        )
    `
    : `
      where coalesce(manifest->>'visibility', 'private') = $1
    `;

  const listParams = hasQuery ? [visibility, `%${q}%`, input.pageSize, offset] : [visibility, input.pageSize, offset];
  const countParams = hasQuery ? [visibility, `%${q}%`] : [visibility];

  const listResult = await pg.query<{
    listing_id: string;
    publisher_id: string;
    agent_id: string;
    manifest: AgentManifest;
    updated_at: string;
  }>(
    `
    select listing_id, publisher_id, agent_id, manifest, updated_at
    from listings
    ${whereSql}
    order by updated_at desc
    limit $${hasQuery ? 3 : 2}
    offset $${hasQuery ? 4 : 3}
  `,
    listParams
  );
  const countResult = await pg.query<{ total: string }>(
    `
    select count(*)::text as total
    from listings
    ${whereSql}
  `,
    countParams
  );

  const items: PublicAgentListItem[] = listResult.rows.map((row) => ({
    canonical_agent_id: getCanonicalAgentId(row.publisher_id, row.agent_id),
    publisher_id: row.publisher_id,
    agent_id: row.agent_id,
    display_name: row.manifest.display_name,
    description: row.manifest.description,
    skills: row.manifest.skills.map((s) => ({ id: s.id, name: s.name, tags: s.tags })),
    visibility: (row.manifest.visibility ?? "private") as PublicAgentListItem["visibility"],
    updated_at: new Date(row.updated_at).toISOString()
  }));

  return {
    items,
    total: Number(countResult.rows[0]?.total ?? "0"),
    page: input.page,
    page_size: input.pageSize
  };
}

export async function listListingsForPublisher(publisherId: string): Promise<PublisherListingItem[]> {
  const result = await pg.query<{
    listing_id: string;
    publisher_id: string;
    agent_id: string;
    manifest: AgentManifest;
    updated_at: string;
  }>(
    `
    select listing_id, publisher_id, agent_id, manifest, updated_at
    from listings
    where publisher_id = $1
    order by updated_at desc
  `,
    [publisherId]
  );
  return result.rows.map((row) => ({
    listing_id: row.listing_id,
    publisher_id: row.publisher_id,
    agent_id: row.agent_id,
    display_name: row.manifest.display_name,
    visibility: (row.manifest.visibility ?? "private") as PublisherListingItem["visibility"],
    updated_at: new Date(row.updated_at).toISOString()
  }));
}

export async function getListingByAgentNamespace(
  publisherId: string,
  agentId: string
): Promise<Listing | null> {
  const result = await pg.query<Listing>(
    `
    select listing_id, publisher_id, manifest, created_at, updated_at
    from listings
    where publisher_id = $1
      and agent_id = $2
  `,
    [publisherId, agentId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    listing_id: row.listing_id,
    publisher_id: row.publisher_id,
    manifest: row.manifest,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString()
  };
}

export async function createProviderSession(input: {
  listing_id: string;
  publisher_id: string;
  max_concurrency: number;
  region_hint?: string;
}): Promise<ProviderSession> {
  const session: ProviderSession = {
    session_id: `ps_${nanoid(10)}`,
    listing_id: input.listing_id,
    publisher_id: input.publisher_id,
    status: "offline",
    max_concurrency: input.max_concurrency,
    current_concurrency: 0,
    region_hint: input.region_hint,
    updated_at: nowIso()
  };
  const key = `provider:session:${session.session_id}`;
  await redis.hSet(
    key,
    toRedisHash({
      ...session,
      latency_ms: "",
      success_rate_1m: ""
    })
  );
  await redis.expire(key, 120);
  await redis.sAdd(`listing:sessions:${session.listing_id}`, session.session_id);
  return session;
}

export async function updateProviderSession(
  sessionId: string,
  patch: Partial<ProviderSession>
): Promise<ProviderSession | null> {
  const session = await getProviderSession(sessionId);
  if (!session) return null;
  const next: ProviderSession = {
    ...session,
    ...patch,
    updated_at: nowIso()
  };
  const key = `provider:session:${sessionId}`;
  await redis.hSet(
    key,
    toRedisHash({
      ...next,
      latency_ms: next.latency_ms ?? "",
      success_rate_1m: next.success_rate_1m ?? ""
    })
  );
  await redis.expire(key, 120);
  return next;
}

export async function getProviderSession(sessionId: string): Promise<ProviderSession | null> {
  const key = `provider:session:${sessionId}`;
  const row = await redis.hGetAll(key);
  if (!row || Object.keys(row).length === 0) return null;
  return {
    session_id: row.session_id,
    listing_id: row.listing_id,
    publisher_id: row.publisher_id,
    status: row.status as ProviderSession["status"],
    max_concurrency: Number(row.max_concurrency),
    current_concurrency: Number(row.current_concurrency),
    region_hint: row.region_hint || undefined,
    latency_ms: row.latency_ms ? Number(row.latency_ms) : undefined,
    success_rate_1m: row.success_rate_1m ? Number(row.success_rate_1m) : undefined,
    updated_at: row.updated_at
  };
}

export async function getListingProviderSessions(listingId: string): Promise<ProviderSession[]> {
  const ids = await redis.sMembers(`listing:sessions:${listingId}`);
  const sessions = await Promise.all(ids.map((id) => getProviderSession(id)));
  return sessions.filter((s): s is ProviderSession => Boolean(s));
}

export async function saveInvocationRecord(record: InvocationRecord): Promise<void> {
  await pg.query(
    `
    insert into invocation_records(request_id, caller_id, listing_id, provider_session_id, status, latency_ms, token_usage, cost, error_code, started_at, finished_at)
    values($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11)
    on conflict (request_id) do update set
      status = excluded.status,
      latency_ms = excluded.latency_ms,
      token_usage = excluded.token_usage,
      cost = excluded.cost,
      error_code = excluded.error_code,
      finished_at = excluded.finished_at
  `,
    [
      record.request_id,
      record.caller_id,
      record.listing_id,
      record.provider_session_id,
      record.status,
      record.latency_ms ?? null,
      record.token_usage ? JSON.stringify(record.token_usage) : null,
      record.cost ?? null,
      record.error_code ?? null,
      record.started_at,
      record.finished_at ?? null
    ]
  );
}

export async function getInvocationRecord(requestId: string): Promise<InvocationRecord | null> {
  const result = await pg.query<InvocationRecord>("select * from invocation_records where request_id = $1", [requestId]);
  const row = result.rows[0];
  if (!row) return null;
  return {
    request_id: row.request_id,
    caller_id: row.caller_id,
    listing_id: row.listing_id,
    provider_session_id: row.provider_session_id,
    status: row.status,
    latency_ms: row.latency_ms ?? undefined,
    token_usage: row.token_usage ?? undefined,
    cost: row.cost ?? undefined,
    error_code: row.error_code ?? undefined,
    started_at: new Date(row.started_at).toISOString(),
    finished_at: row.finished_at ? new Date(row.finished_at).toISOString() : undefined
  };
}

export async function getMetricsSummary(): Promise<{
  providers_online: number;
  invocations_total: number;
  invocations_succeeded: number;
  invocations_failed: number;
  success_rate: number;
}> {
  const providerKeys = await redis.keys("provider:session:*");
  let providersOnline = 0;
  if (providerKeys.length > 0) {
    const rows = await Promise.all(providerKeys.map((key) => redis.hGet(key, "status")));
    providersOnline = rows.filter((s) => s === "online").length;
  }

  const inv = await pg.query<{ total: string; succ: string; fail: string }>(`
    select count(*)::text as total,
           count(*) filter (where status = 'succeeded')::text as succ,
           count(*) filter (where status = 'failed')::text as fail
    from invocation_records
  `);
  const total = Number(inv.rows[0]?.total ?? "0");
  const succ = Number(inv.rows[0]?.succ ?? "0");
  const fail = Number(inv.rows[0]?.fail ?? "0");
  return {
    providers_online: providersOnline,
    invocations_total: total,
    invocations_succeeded: succ,
    invocations_failed: fail,
    success_rate: total === 0 ? 1 : succ / total
  };
}

export async function recordSettlementEntries(input: {
  request_id: string;
  caller_id: string;
  publisher_id: string;
  amount: number;
  currency: string;
}): Promise<void> {
  const platformFee = Number((input.amount * 0.1).toFixed(6));
  const publisherNet = Number((input.amount - platformFee).toFixed(6));
  const callerWallet = `acc_caller_${input.caller_id}_${input.currency}`;
  const publisherEarnings = `acc_pub_${input.publisher_id}_${input.currency}`;
  const platformRevenue = `acc_platform_${input.currency}`;

  await pg.query("begin");
  try {
    await ensureAccount(callerWallet, "caller_wallet", input.caller_id, input.currency);
    await ensureAccount(publisherEarnings, "publisher_earnings", input.publisher_id, input.currency);
    await ensureAccount(platformRevenue, "platform_revenue", "platform", input.currency);

    await insertLedger(input.request_id, callerWallet, input.amount, "debit", input.currency, "caller charge");
    await insertLedger(input.request_id, publisherEarnings, publisherNet, "credit", input.currency, "publisher earnings");
    await insertLedger(input.request_id, platformRevenue, platformFee, "credit", input.currency, "platform fee");

    await pg.query("commit");
  } catch (err) {
    await pg.query("rollback");
    throw err;
  }
}

async function ensureAccount(
  accountId: string,
  accountType: "caller_wallet" | "publisher_earnings" | "platform_revenue",
  ownerId: string,
  currency: string
): Promise<void> {
  await pg.query(
    `
    insert into ledger_accounts(account_id, account_type, owner_id, currency)
    values($1, $2, $3, $4)
    on conflict (account_id) do nothing
  `,
    [accountId, accountType, ownerId, currency]
  );
}

async function insertLedger(
  requestId: string,
  accountId: string,
  amount: number,
  direction: "debit" | "credit",
  currency: string,
  memo: string
): Promise<void> {
  await pg.query(
    `
    insert into ledger_entries(entry_id, request_id, account_id, amount, direction, currency, memo)
    values($1,$2,$3,$4,$5,$6,$7)
  `,
    [`led_${nanoid(12)}`, requestId, accountId, amount, direction, currency, memo]
  );
}

export async function runSettlementForPublisher(input: {
  publisher_id: string;
  period_start: string;
  period_end: string;
}): Promise<{ settlement_id: string; gross_amount: number; net_amount: number; platform_fee: number }> {
  const result = await pg.query<{ gross: string }>(
    `
    select coalesce(sum(amount), 0)::text as gross
    from ledger_entries le
    join ledger_accounts la on la.account_id = le.account_id
    where la.account_type = 'publisher_earnings'
      and la.owner_id = $1
      and le.created_at >= $2::timestamptz
      and le.created_at < $3::timestamptz
      and le.direction = 'credit'
  `,
    [input.publisher_id, input.period_start, input.period_end]
  );
  const gross = Number(result.rows[0]?.gross ?? "0");
  const platformFee = Number((gross * 0.1).toFixed(6));
  const net = Number((gross - platformFee).toFixed(6));
  const settlementId = `set_${nanoid(12)}`;
  await pg.query(
    `
    insert into settlements(settlement_id, publisher_id, period_start, period_end, gross_amount, platform_fee, net_amount, status)
    values($1,$2,$3,$4,$5,$6,$7,'open')
  `,
    [settlementId, input.publisher_id, input.period_start, input.period_end, gross, platformFee, net]
  );
  return { settlement_id: settlementId, gross_amount: gross, net_amount: net, platform_fee: platformFee };
}

export async function touchCircuit(sessionId: string, succeeded: boolean): Promise<void> {
  const key = `cb:${sessionId}`;
  if (succeeded) {
    await redis.del(key);
    return;
  }
  const failures = await redis.hIncrBy(key, "failures", 1);
  if (failures >= 3) {
    await redis.hSet(key, "openedUntil", String(Date.now() + 30_000));
  }
  await redis.expire(key, 300);
}

export async function getCircuitOpenedUntil(sessionId: string): Promise<number | undefined> {
  const value = await redis.hGet(`cb:${sessionId}`, "openedUntil");
  return value ? Number(value) : undefined;
}
