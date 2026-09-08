-- WebCliniQ — Step 3 schema
-- Run in the Supabase SQL editor. Safe to re-run.

-- ---------- audits ----------
create table if not exists public.audits (
  id                uuid primary key default gen_random_uuid(),
  created_at        timestamptz not null default now(),
  ip_address        text,
  search_query      text,
  health_score      integer,
  top_findings      jsonb,
  all_findings      jsonb,
  had_website       boolean,
  had_business_name boolean
);

alter table public.audits add column if not exists public_id  text;
alter table public.audits add column if not exists screenshot text;   -- PSI phone screenshot, data: URI
create unique index if not exists audits_public_id_key on public.audits (public_id);
create index if not exists audits_ip_created_idx on public.audits (ip_address, created_at desc);

-- ---------- audit_leads ----------
create table if not exists public.audit_leads (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  email        text not null,
  search_query text,
  health_score integer,
  findings     jsonb
);

alter table public.audit_leads add column if not exists audit_id   uuid references public.audits(id) on delete set null;
alter table public.audit_leads add column if not exists consent_at timestamptz;   -- when they asked for the email
alter table public.audit_leads add column if not exists source     text;          -- 'audit_email'
alter table public.audit_leads add column if not exists status     text default 'new';  -- new | contacted | won | lost
alter table public.audit_leads add column if not exists notes      text;
create index if not exists audit_leads_status_idx on public.audit_leads (status, created_at desc);

-- The function uses the service-role key and bypasses RLS. If RLS is enabled,
-- no public policies are needed — keep both tables private.
