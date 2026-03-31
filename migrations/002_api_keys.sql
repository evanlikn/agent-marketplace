create table if not exists api_keys (
  key_id text primary key,
  key_hash text not null unique,
  caller_id text not null,
  scope text not null default 'invoke',
  monthly_quota bigint not null default 10000,
  qps_limit integer not null default 20,
  concurrent_limit integer not null default 10,
  status text not null check (status in ('active', 'revoked')) default 'active',
  created_at timestamptz not null default now()
);
