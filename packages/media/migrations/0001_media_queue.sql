-- MASK WARS media queue: drafts for X and one row of settings. Server only: RLS on, no policy, no browser grants.
-- States: pending → approved → posted | rejected (rejected from pending or approved). One moment, one draft (key).
-- The poster flips a status only with `where status = <from>`, so two runs never take the same draft.

create schema if not exists media;
revoke all on schema media from public;
revoke all on schema media from anon, authenticated;

create table media.drafts (
  id uuid primary key,
  key text not null unique check (char_length(key) between 1 and 200),
  text text not null check (char_length(text) between 1 and 1000),
  reply text not null check (char_length(reply) between 1 and 1000),
  grid boolean not null default false,
  media text,
  source text not null check (source in ('LIVE', 'SIMULATED')),
  status text not null default 'pending' check (status in ('pending', 'approved', 'posted', 'rejected')),
  problems jsonb not null default '[]',
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  posted_at timestamptz,
  post_id text unique check (post_id is null or post_id ~ '^[0-9]{1,20}$'),
  reply_id text check (reply_id is null or reply_id ~ '^[0-9]{1,20}$'),
  tries integer not null default 0 check (tries >= 0),
  last_error text,
  -- nothing goes out without a decision, nothing simulated goes out at all
  check (status = 'pending' or decided_at is not null),
  check ((status = 'posted') = (post_id is not null and posted_at is not null)),
  check (status not in ('approved', 'posted') or source = 'LIVE')
);
create index drafts_status_idx on media.drafts (status, created_at);
create index drafts_posted_idx on media.drafts (posted_at) where status = 'posted';
-- the same text twice in a week is a duplicate: checked by the store against this index
create index drafts_text_idx on media.drafts (md5(lower(regexp_replace(text, '\s+', ' ', 'g'))), created_at);

-- Only allowed moves.
create function media.draft_transition() returns trigger language plpgsql as $$
begin
  if old.status = new.status then return new; end if;
  if (old.status = 'pending' and new.status in ('approved', 'rejected'))
     or (old.status = 'approved' and new.status in ('posted', 'rejected')) then
    return new;
  end if;
  raise exception 'media.drafts: % → % is not allowed', old.status, new.status;
end $$;
create trigger drafts_transition before update on media.drafts for each row execute function media.draft_transition();

create table media.settings (
  id boolean primary key default true check (id),
  stopped boolean not null default false,
  daily_cap integer not null default 12 check (daily_cap between 0 and 100),
  per_hour integer not null default 2 check (per_hour between 0 and 20),
  updated_at timestamptz not null default now()
);
insert into media.settings (id) values (true);

alter table media.drafts enable row level security;
alter table media.settings enable row level security;
revoke all on all tables in schema media from public, anon, authenticated;
revoke all on all functions in schema media from public, anon, authenticated;
