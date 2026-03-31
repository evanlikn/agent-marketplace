create extension if not exists "pgcrypto";

create table if not exists oauth_clients (
  client_id text primary key,
  client_secret_hash text not null,
  role text not null check (role in ('caller', 'publisher', 'admin')),
  caller_id text,
  publisher_id text,
  monthly_quota bigint not null default 10000,
  qps_limit integer not null default 20,
  concurrent_limit integer not null default 10,
  created_at timestamptz not null default now()
);

create table if not exists oauth_device_codes (
  device_code text primary key,
  user_code text unique not null,
  client_id text not null references oauth_clients(client_id),
  scope text not null,
  status text not null check (status in ('pending', 'approved', 'denied')),
  subject text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists listings (
  listing_id text primary key,
  publisher_id text not null,
  agent_id text not null,
  manifest jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (publisher_id, agent_id)
);

create table if not exists invocation_records (
  request_id text primary key,
  caller_id text not null,
  listing_id text not null references listings(listing_id),
  provider_session_id text not null,
  status text not null,
  latency_ms integer,
  token_usage jsonb,
  cost numeric(18, 6),
  error_code text,
  started_at timestamptz not null,
  finished_at timestamptz
);

create table if not exists ledger_accounts (
  account_id text primary key,
  account_type text not null check (account_type in ('caller_wallet', 'publisher_earnings', 'platform_revenue')),
  owner_id text not null,
  currency text not null,
  created_at timestamptz not null default now(),
  unique (account_type, owner_id, currency)
);

create table if not exists ledger_entries (
  entry_id text primary key,
  request_id text not null references invocation_records(request_id),
  account_id text not null references ledger_accounts(account_id),
  amount numeric(18, 6) not null,
  direction text not null check (direction in ('debit', 'credit')),
  currency text not null,
  memo text,
  created_at timestamptz not null default now()
);

create table if not exists settlements (
  settlement_id text primary key,
  publisher_id text not null,
  period_start timestamptz not null,
  period_end timestamptz not null,
  gross_amount numeric(18, 6) not null,
  platform_fee numeric(18, 6) not null,
  net_amount numeric(18, 6) not null,
  status text not null check (status in ('open', 'paid', 'failed')),
  created_at timestamptz not null default now()
);
