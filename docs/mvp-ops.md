# Ops Checklist

## Grey rollout

1. Start marketplace server in staging.
2. Publish one internal test agent.
3. Bring one provider daemon online behind NAT.
4. Run synthetic invocation every 30s.
5. Validate summary metrics and invocation records.

## Alerts

Track and alert on:

- provider offline count > 0 for 5 minutes
- success rate < 0.9
- p95 latency > declared SLA
- repeated provider circuit breaker openings
- oauth token issuance failures
- redis unavailable / postgres unavailable (`/readyz` not ready)

## Billing and settlement

For each finished invocation record:

- read `listing_id`, `caller_id`, `cost`, `token_usage`, `status`
- aggregate by publisher and billing cycle
- emit settlement CSV for payout pipeline
- trigger `POST /v1/settlements/run` per billing cycle and reconcile ledger balances

## Security reminders

- never store raw local knowledge base content in manifest
- use API key rotation for caller keys
- scrub payload fields before logging in production
