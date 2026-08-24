create table if not exists principals (
  id text primary key,
  organization_id text,
  created_at timestamptz not null default now()
);

create table if not exists principal_identities (
  provider text not null check (provider in ('github', 'slack')),
  provider_tenant_id text not null,
  provider_user_id text not null,
  principal_id text not null references principals(id),
  verified_at timestamptz not null,
  primary key (provider, provider_tenant_id, provider_user_id)
);

create table if not exists conversations (
  id uuid primary key,
  conversation_key text not null unique,
  source text not null check (source in ('github', 'slack')),
  repository_id text,
  repository_owner text,
  repository_name text,
  github_installation_id bigint,
  pull_request_number integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table conversations add column if not exists repository_owner text;
alter table conversations add column if not exists repository_name text;
alter table conversations add column if not exists github_installation_id bigint;

create table if not exists tasks (
  id uuid primary key,
  conversation_id uuid not null references conversations(id),
  kind text not null check (kind in ('pr_review', 'change_request', 'memory', 'question')),
  state text not null check (state in ('queued', 'waiting_for_ci', 'reviewing', 'waiting_for_user', 'publishing', 'completed', 'superseded', 'failed', 'cancelled')),
  requested_by text references principals(id),
  repository_id text,
  head_sha text,
  deadline_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists tasks_active_review_head
  on tasks(conversation_id, head_sha)
  where kind = 'pr_review' and state not in ('completed', 'superseded', 'failed', 'cancelled');

create table if not exists event_deliveries (
  provider text not null,
  delivery_id text not null,
  received_at timestamptz not null default now(),
  payload_sha256 text not null,
  primary key (provider, delivery_id)
);

create table if not exists check_snapshots (
  task_id uuid not null references tasks(id) on delete cascade,
  head_sha text not null,
  check_name text not null,
  status text not null,
  conclusion text,
  observed_at timestamptz not null default now(),
  primary key (task_id, head_sha, check_name)
);

create table if not exists memory_records (
  id uuid primary key,
  scope_kind text not null check (scope_kind in ('user', 'organization', 'repository', 'pull_request')),
  scope_key text not null,
  content text not null check (length(content) between 1 and 8000),
  tags text[] not null default '{}',
  source_url text,
  author_principal_id text not null references principals(id),
  status text not null check (status in ('proposed', 'confirmed', 'superseded')),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists memory_records_scope
  on memory_records(scope_key, status);

create table if not exists approval_requests (
  id uuid primary key,
  task_id uuid not null references tasks(id) on delete cascade,
  capability text not null,
  requested_from text references principals(id),
  decision text check (decision in ('approved', 'denied')),
  decided_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists audit_events (
  id bigserial primary key,
  task_id uuid references tasks(id),
  actor_principal_id text references principals(id),
  action text not null,
  target text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);
