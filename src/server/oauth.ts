import { nanoid } from "nanoid";
import jwt from "jsonwebtoken";
import { pg, redis } from "./db.js";
import { config } from "./config.js";
import { OAuthClientRecord } from "./repositories.js";

export interface AccessClaims {
  sub: string;
  role: "caller" | "publisher" | "admin";
  caller_id?: string;
  publisher_id?: string;
  client_id: string;
  scope: string;
}

export function signAccessToken(claims: AccessClaims): string {
  return jwt.sign(claims, config.jwtSecret, {
    issuer: config.jwtIssuer,
    audience: config.jwtAudience,
    expiresIn: config.accessTokenTtlSec
  });
}

export function verifyAccessToken(token: string): AccessClaims {
  return jwt.verify(token, config.jwtSecret, {
    issuer: config.jwtIssuer,
    audience: config.jwtAudience
  }) as AccessClaims;
}

export async function issueClientCredentialsToken(
  client: OAuthClientRecord,
  scope: string
): Promise<{
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
}> {
  const claims: AccessClaims = {
    sub: client.caller_id ?? client.publisher_id ?? client.client_id,
    role: client.role,
    caller_id: client.caller_id ?? undefined,
    publisher_id: client.publisher_id ?? undefined,
    client_id: client.client_id,
    scope
  };
  return {
    access_token: signAccessToken(claims),
    token_type: "Bearer",
    expires_in: config.accessTokenTtlSec
  };
}

export async function createDeviceCode(input: {
  client_id: string;
  scope: string;
}): Promise<{
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}> {
  const deviceCode = `dc_${nanoid(24)}`;
  const userCode = nanoid(8).toUpperCase();
  const expiresIn = 600;
  await pg.query(
    `
    insert into oauth_device_codes(device_code, user_code, client_id, scope, status, expires_at)
    values($1,$2,$3,$4,'pending', now() + interval '10 minutes')
  `,
    [deviceCode, userCode, input.client_id, input.scope]
  );
  const base = config.deviceVerificationUriBase.replace(/\/$/, "");
  return {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: `${base}/device`,
    verification_uri_complete: `${base}/device?user_code=${userCode}`,
    expires_in: expiresIn,
    interval: 5
  };
}

export async function approveDeviceCode(userCode: string, subject: string): Promise<boolean> {
  const result = await pg.query(
    `
    update oauth_device_codes
    set status = 'approved', subject = $1
    where user_code = $2
      and expires_at > now()
      and status = 'pending'
  `,
    [subject, userCode]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function pollDeviceCodeToken(input: {
  client_id: string;
  device_code: string;
}): Promise<{ pending: boolean; token?: string; claims?: AccessClaims }> {
  const result = await pg.query<{
    status: "pending" | "approved" | "denied";
    subject: string | null;
    scope: string;
    expires_at: string;
  }>(
    `
    select status, subject, scope, expires_at
    from oauth_device_codes
    where device_code = $1
      and client_id = $2
  `,
    [input.device_code, input.client_id]
  );
  const row = result.rows[0];
  if (!row) throw new Error("invalid_device_code");
  if (new Date(row.expires_at).getTime() < Date.now()) throw new Error("expired_token");
  if (row.status === "pending") return { pending: true };
  if (row.status === "denied") throw new Error("access_denied");

  const claims: AccessClaims = {
    sub: row.subject ?? input.client_id,
    role: "publisher",
    publisher_id: row.subject ?? undefined,
    client_id: input.client_id,
    scope: row.scope
  };
  const token = signAccessToken(claims);
  const refreshToken = `rt_${nanoid(28)}`;
  await redis.setEx(
    `oauth:refresh:${refreshToken}`,
    config.refreshTokenTtlSec,
    JSON.stringify({
      claims
    })
  );
  return { pending: false, token, claims };
}

export async function issueFromRefreshToken(refreshToken: string): Promise<{
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
}> {
  const payload = await redis.get(`oauth:refresh:${refreshToken}`);
  if (!payload) throw new Error("invalid_grant");
  const parsed = JSON.parse(payload) as { claims: AccessClaims };
  return {
    access_token: signAccessToken(parsed.claims),
    token_type: "Bearer",
    expires_in: config.accessTokenTtlSec
  };
}
