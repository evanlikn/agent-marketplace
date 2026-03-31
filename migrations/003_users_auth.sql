create table if not exists users (
  user_id text primary key,
  email text not null unique,
  password_hash text not null,
  display_name text not null,
  caller_id text not null unique,
  oauth_client_id text not null unique references oauth_clients(client_id),
  created_at timestamptz not null default now()
);
