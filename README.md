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
- `POST /oauth/device/approve`
- `POST /v1/auth/register`
- `POST /v1/auth/login`
- `GET /v1/auth/me`
- `POST /v1/auth/api-key/create`

## Billing and metrics

- `GET /v1/metrics/summary`
- `GET /v1/invocations/:requestId`
- `POST /v1/settlements/run`

