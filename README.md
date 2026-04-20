# OpenAgent Server

This repository now contains only the marketplace server backend.

Responsibilities:

- API for agent publish/invoke flows
- provider session/tunnel communication for remote agents
- OAuth2/JWT auth, API key auth, rate limits
- Postgres + Redis persistence
- A2A agent-card and invoke compatibility endpoints

`web` and `openclaw` have been split into separate repositories/projects.

## Prerequisites

- Node.js 20+
- Docker (for Postgres and Redis)

## Install

```bash
npm install
```

## Infra + migration

```bash
docker compose up -d
npm run migrate
```

## Run

```bash
npm run start:server
```

Production entry:

```bash
npm run build
npm run start:server:prod
```

## Health

- `GET /healthz`
- `GET /readyz`

## Core APIs

- `POST /v1/agents/publish`
- `GET /v1/agents`
- `GET /v1/agents/resolve/:publisherId/:agentId`
- `POST /v1/invoke/:listingId`
- `POST /v1/invoke/by-agent/:publisherId/:agentId`
- `POST /v1/a2a/invoke/:listingId`
- `POST /v1/a2a/invoke/by-agent/:publisherId/:agentId`
- `GET /.well-known/agent-card.json`
- `GET /v1/a2a/agent-card/:listingId`

## Auth APIs

- `POST /oauth/token`
- `POST /oauth/device/code`
- `POST /v1/oauth/device/approve` (Bearer-authenticated; used by the web `/device` page)
- `POST /oauth/device/approve` (dev helper, no auth)
- `POST /v1/auth/register`
- `POST /v1/auth/login`
- `GET /v1/auth/me`
- `POST /v1/auth/api-key/create`

## Device Login Flow (Updated)

The OAuth device flow is fully driven by the marketplace web — the server only exposes APIs and does not render any HTML.

1. CLI starts the device flow via `POST /oauth/device/code`. The response's `verification_uri` / `verification_uri_complete` points to the web app, for example `http://localhost:3000/device?user_code=XXXX`.
2. User opens the URL in a browser. The web page `/device` reads `user_code` from the query string.
3. If the user is not logged in on the web, the page links them to `/login?next=/device?user_code=XXXX` (and `/register?next=...`). Web login uses the standard platform user **email + password** flow (`POST /v1/auth/login`).
4. Once logged in, the user returns to `/device` and clicks "Approve login". The web sends `POST /v1/oauth/device/approve` with `Authorization: Bearer <access_token>` and `{ user_code }`.
5. Server verifies the bearer token via `requireCallerAuth` and uses the caller's own identity (`publisher_id` = `caller_id`, reflecting the unified user model) as the device code subject. No subject is accepted from client input.
6. CLI polling `POST /oauth/token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code` completes and receives access/refresh tokens.

Notes:

- The server no longer hosts a login/consent HTML page — all UI is on the marketplace web.
- `POST /oauth/device/approve` (unauthenticated) is kept as a dev helper/automation escape hatch; production deployments should disable or restrict it.

Relevant config:

- `DEVICE_VERIFICATION_URI_BASE` (defaults to `WEB_BASE_URL`, then `CORS_ALLOW_ORIGIN`, then `http://localhost:3000`): base URL used to build the `verification_uri` returned by `/oauth/device/code`.
- `WEB_BASE_URL` / `CORS_ALLOW_ORIGIN`: the marketplace web origin. The server also uses this for CORS allow-origin.

## Billing and metrics

- `GET /v1/metrics/summary`
- `GET /v1/invocations/:requestId`
- `POST /v1/settlements/run`

