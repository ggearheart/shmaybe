-- ===========================================================================
-- Shmaybe — Supabase schema
-- Run once: Supabase → SQL Editor → New query → paste → Run.
--
-- Security model: there is no login. A plan is reachable by anyone holding its
-- slug, which is a random 12-character code. To stop the whole internet from
-- enumerating plans, the tables themselves are closed to the anon role and
-- every operation goes through a security-definer function that requires the
-- slug. Editing your own row additionally requires the claim token handed out
-- when you joined.
-- ===========================================================================

create extension if not exists pgcrypto;

-- --- Tables ----------------------------------------------------------------

create table if not exists public.plans (
  id            uuid primary key default gen_random_uuid(),
  slug          text unique not null,
  title         text not null,
  window_start  date not null,
  window_end    date not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Candidate things to do. Several can compete inside one plan: everyone gives
-- their availability once, then says how they feel about each activity.
create table if not exists public.activities (
  id           uuid primary key default gen_random_uuid(),
  plan_id      uuid not null references public.plans(id) on delete cascade,
  title        text not null,
  detail       text not null default '',
  proposed_by  text not null default '',
  archived     boolean not null default false,
  created_at   timestamptz not null default now()
);
create index if not exists activities_plan_idx on public.activities(plan_id);

-- One row per person per plan. Availability lives here (given once); how they
-- feel about each activity lives in `interests`.
create table if not exists public.participants (
  id               uuid primary key default gen_random_uuid(),
  plan_id          uuid not null references public.plans(id) on delete cascade,
  name             text not null,
  claim_token      uuid,                       -- null = organizer added them, nobody has claimed it yet
  weekdays         int[]  not null default '{}',      -- allowed weekdays; empty = no restriction
  blackouts        date[] not null default '{}',
  blackout_ranges  jsonb  not null default '[]',      -- [{start,end}]
  only_dates       date[] not null default '{}',
  notice_days      int    not null default 0,
  note             text   not null default '',        -- what they typed, verbatim
  unlocks          jsonb  not null default '[]',      -- [{id,text,condition,weekdays,dates}]
  updated_at       timestamptz not null default now(),
  created_at       timestamptz not null default now()
);
create index if not exists participants_plan_idx on public.participants(plan_id);
create unique index if not exists participants_plan_name_idx
  on public.participants(plan_id, lower(name));

create table if not exists public.interests (
  participant_id  uuid not null references public.participants(id) on delete cascade,
  activity_id     uuid not null references public.activities(id) on delete cascade,
  level           text not null default 'pending',    -- 'yes' | 'maybe' | 'no' | 'pending'
  note            text not null default '',
  updated_at      timestamptz not null default now(),
  primary key (participant_id, activity_id)
);

-- --- Lock the tables down --------------------------------------------------
-- RLS on with no policies = no direct access for anon or authenticated.
-- Everything below runs as the definer instead.

alter table public.plans        enable row level security;
alter table public.activities   enable row level security;
alter table public.participants enable row level security;
alter table public.interests    enable row level security;

revoke all on public.plans, public.activities, public.participants, public.interests
  from anon, authenticated;

-- --- Helpers ---------------------------------------------------------------

-- Unambiguous alphabet: no 0/O/1/l/I, so a slug survives being read aloud
-- or copied off a phone screen.
create or replace function public.shmaybe_slug()
returns text language sql volatile as $$
  select string_agg(
    substr('abcdefghjkmnpqrstuvwxyz23456789',
           1 + floor(random() * 30)::int, 1), '')
  from generate_series(1, 12);
$$;

create or replace function public.shmaybe_plan_id(p_slug text)
returns uuid language sql stable security definer set search_path = public as $$
  select id from public.plans where slug = p_slug;
$$;

-- Confirms this token really belongs to this person in this plan.
create or replace function public.shmaybe_auth(p_slug text, p_token uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select p.id
  from public.participants p
  join public.plans pl on pl.id = p.plan_id
  where pl.slug = p_slug and p.claim_token = p_token;
$$;

-- --- Read ------------------------------------------------------------------

-- The whole plan in one round trip. Deliberately never returns claim_token.
create or replace function public.get_plan(p_slug text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', pl.id,
    'slug', pl.slug,
    'title', pl.title,
    'window', jsonb_build_object('start', pl.window_start, 'end', pl.window_end),
    'updatedAt', pl.updated_at,
    'activities', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', a.id, 'title', a.title, 'detail', a.detail,
               'proposedBy', a.proposed_by, 'createdAt', a.created_at)
             order by a.created_at)
      from public.activities a
      where a.plan_id = pl.id and not a.archived), '[]'::jsonb),
    'participants', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'name', p.name,
               'claimed', p.claim_token is not null,
               'weekdays', p.weekdays, 'blackouts', p.blackouts,
               'blackoutRanges', p.blackout_ranges, 'onlyDates', p.only_dates,
               'noticeDays', p.notice_days, 'note', p.note, 'unlocks', p.unlocks,
               'updatedAt', p.updated_at,
               'interests', coalesce((
                 select jsonb_object_agg(i.activity_id,
                          jsonb_build_object('level', i.level, 'note', i.note))
                 from public.interests i where i.participant_id = p.id), '{}'::jsonb))
             order by p.created_at)
      from public.participants p
      where p.plan_id = pl.id), '[]'::jsonb)
  )
  from public.plans pl
  where pl.slug = p_slug;
$$;

-- --- Write -----------------------------------------------------------------

create or replace function public.create_plan(
  p_title text, p_start date, p_end date, p_activity text, p_name text)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_slug text;
  v_plan uuid;
  v_act  uuid;
  v_part uuid;
  v_token uuid := gen_random_uuid();
begin
  if coalesce(trim(p_title), '') = '' then
    raise exception 'A plan needs a title';
  end if;
  if p_end < p_start then
    raise exception 'The window ends before it starts';
  end if;

  -- Retry on the astronomically unlikely slug collision.
  loop
    v_slug := public.shmaybe_slug();
    exit when not exists (select 1 from public.plans where slug = v_slug);
  end loop;

  insert into public.plans (slug, title, window_start, window_end)
  values (v_slug, trim(p_title), p_start, p_end)
  returning id into v_plan;

  if coalesce(trim(p_activity), '') <> '' then
    insert into public.activities (plan_id, title, proposed_by)
    values (v_plan, trim(p_activity), coalesce(trim(p_name), ''))
    returning id into v_act;
  end if;

  if coalesce(trim(p_name), '') <> '' then
    insert into public.participants (plan_id, name, claim_token)
    values (v_plan, trim(p_name), v_token)
    returning id into v_part;
  end if;

  -- Naming the first activity counts as being up for it, the same way
  -- proposing one later does.
  if v_part is not null and v_act is not null then
    insert into public.interests (participant_id, activity_id, level)
    values (v_part, v_act, 'yes');
  end if;

  return jsonb_build_object('slug', v_slug, 'participantId', v_part, 'token', v_token);
end;
$$;

-- Join a plan by name. Claims an unclaimed row of the same name if one exists
-- (so an organizer can pre-seed the roster from texts and people slot in),
-- otherwise creates a new one.
create or replace function public.join_plan(p_slug text, p_name text)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_plan  uuid := public.shmaybe_plan_id(p_slug);
  v_part  uuid;
  v_token uuid := gen_random_uuid();
  v_existing public.participants%rowtype;
begin
  if v_plan is null then raise exception 'No such plan'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'A name is required'; end if;

  select * into v_existing from public.participants
   where plan_id = v_plan and lower(name) = lower(trim(p_name));

  if found then
    if v_existing.claim_token is not null then
      raise exception 'Someone already claimed the name %', v_existing.name
        using errcode = 'unique_violation';
    end if;
    update public.participants set claim_token = v_token, updated_at = now()
     where id = v_existing.id;
    v_part := v_existing.id;
  else
    insert into public.participants (plan_id, name, claim_token)
    values (v_plan, trim(p_name), v_token)
    returning id into v_part;
  end if;

  return jsonb_build_object('participantId', v_part, 'token', v_token);
end;
$$;

-- Shared patch application, so update_participant and fill_in_for cannot drift
-- apart.
create or replace function public.shmaybe_apply_patch(p_part uuid, p_patch jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.participants set
    name = coalesce(nullif(trim(p_patch->>'name'), ''), name),
    weekdays = case when p_patch ? 'weekdays'
      then coalesce((select array_agg(x::int) from jsonb_array_elements_text(p_patch->'weekdays') x), '{}'::int[])
      else weekdays end,
    blackouts = case when p_patch ? 'blackouts'
      then coalesce((select array_agg(x::date) from jsonb_array_elements_text(p_patch->'blackouts') x), '{}'::date[])
      else blackouts end,
    blackout_ranges = coalesce(p_patch->'blackoutRanges', blackout_ranges),
    only_dates = case when p_patch ? 'onlyDates'
      then coalesce((select array_agg(x::date) from jsonb_array_elements_text(p_patch->'onlyDates') x), '{}'::date[])
      else only_dates end,
    notice_days = coalesce((p_patch->>'noticeDays')::int, notice_days),
    note = coalesce(p_patch->>'note', note),
    unlocks = coalesce(p_patch->'unlocks', unlocks),
    updated_at = now()
  where id = p_part;
end;
$$;

create or replace function public.update_participant(p_slug text, p_token uuid, p_patch jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare v_part uuid := public.shmaybe_auth(p_slug, p_token);
begin
  if v_part is null then raise exception 'Not your row to edit'; end if;
  perform public.shmaybe_apply_patch(v_part, p_patch);
  return jsonb_build_object('ok', true);
end;
$$;

-- Write constraints for somebody who has not joined — this is what makes
-- pasting a group text thread possible. Creates the row if the name is new;
-- refuses outright once they have claimed it. You may speak for someone who
-- has not spoken for themselves, and only until they do.
create or replace function public.fill_in_for(
  p_slug text, p_token uuid, p_name text,
  p_patch jsonb default '{}'::jsonb, p_interests jsonb default '{}'::jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_caller  uuid := public.shmaybe_auth(p_slug, p_token);
  v_plan    uuid := public.shmaybe_plan_id(p_slug);
  v_part    uuid;
  v_claimed uuid;
  k text; v text;
begin
  if v_caller is null then raise exception 'Join the plan before filling in for others'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'A name is required'; end if;

  select id, claim_token into v_part, v_claimed
    from public.participants
   where plan_id = v_plan and lower(name) = lower(trim(p_name));

  if v_part is null then
    insert into public.participants (plan_id, name)
    values (v_plan, trim(p_name)) returning id into v_part;
  elsif v_claimed is not null then
    raise exception '% has joined and controls their own answers', trim(p_name)
      using errcode = 'insufficient_privilege';
  end if;

  perform public.shmaybe_apply_patch(v_part, p_patch);

  for k, v in select key, value from jsonb_each_text(coalesce(p_interests, '{}'::jsonb)) loop
    if v in ('yes','maybe','no','pending')
       and exists (select 1 from public.activities a where a.id = k::uuid and a.plan_id = v_plan) then
      insert into public.interests (participant_id, activity_id, level)
      values (v_part, k::uuid, v)
      on conflict (participant_id, activity_id) do update
        set level = excluded.level, updated_at = now();
    end if;
  end loop;

  return jsonb_build_object('participantId', v_part);
end;
$$;

create or replace function public.set_interest(
  p_slug text, p_token uuid, p_activity uuid, p_level text, p_note text default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare v_part uuid := public.shmaybe_auth(p_slug, p_token);
begin
  if v_part is null then raise exception 'Not your row to edit'; end if;
  if p_level not in ('yes', 'maybe', 'no', 'pending') then
    raise exception 'Unknown interest level %', p_level;
  end if;
  if not exists (select 1 from public.activities a
                 where a.id = p_activity and a.plan_id = public.shmaybe_plan_id(p_slug)) then
    raise exception 'That activity is not part of this plan';
  end if;

  insert into public.interests (participant_id, activity_id, level, note)
  values (v_part, p_activity, p_level, coalesce(p_note, ''))
  on conflict (participant_id, activity_id) do update
    set level = excluded.level,
        note = coalesce(p_note, public.interests.note),
        updated_at = now();

  return jsonb_build_object('ok', true);
end;
$$;

-- Anyone in the plan can float an alternative.
create or replace function public.add_activity(
  p_slug text, p_token uuid, p_title text, p_detail text default '')
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_part uuid := public.shmaybe_auth(p_slug, p_token);
  v_plan uuid := public.shmaybe_plan_id(p_slug);
  v_name text;
  v_act  uuid;
begin
  if v_part is null then raise exception 'Join the plan before proposing something'; end if;
  if coalesce(trim(p_title), '') = '' then raise exception 'The activity needs a name'; end if;
  if (select count(*) from public.activities where plan_id = v_plan and not archived) >= 12 then
    raise exception 'That is already a dozen options — retire one first';
  end if;

  select name into v_name from public.participants where id = v_part;

  insert into public.activities (plan_id, title, detail, proposed_by)
  values (v_plan, trim(p_title), coalesce(trim(p_detail), ''), v_name)
  returning id into v_act;

  -- Proposing something counts as being up for it.
  insert into public.interests (participant_id, activity_id, level)
  values (v_part, v_act, 'yes')
  on conflict do nothing;

  return jsonb_build_object('activityId', v_act);
end;
$$;

-- Only whoever proposed it can retire it.
create or replace function public.archive_activity(p_slug text, p_token uuid, p_activity uuid)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_part uuid := public.shmaybe_auth(p_slug, p_token);
  v_name text;
begin
  if v_part is null then raise exception 'Not yours to retire'; end if;
  select name into v_name from public.participants where id = v_part;

  update public.activities set archived = true
   where id = p_activity
     and plan_id = public.shmaybe_plan_id(p_slug)
     and proposed_by = v_name;

  if not found then raise exception 'Only the person who proposed it can retire it'; end if;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.update_plan(
  p_slug text, p_token uuid, p_title text, p_start date, p_end date)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare v_part uuid := public.shmaybe_auth(p_slug, p_token);
begin
  if v_part is null then raise exception 'Join the plan first'; end if;
  if p_end < p_start then raise exception 'The window ends before it starts'; end if;

  update public.plans set
    title = coalesce(nullif(trim(p_title), ''), title),
    window_start = p_start, window_end = p_end, updated_at = now()
  where slug = p_slug;

  return jsonb_build_object('ok', true);
end;
$$;

-- A cheap freshness check so the app can poll without pulling the whole plan.
create or replace function public.plan_pulse(p_slug text)
returns timestamptz language sql stable security definer set search_path = public as $$
  select greatest(
    pl.updated_at,
    coalesce((select max(p.updated_at) from public.participants p where p.plan_id = pl.id), pl.updated_at),
    coalesce((select max(i.updated_at) from public.interests i
              join public.participants p on p.id = i.participant_id
              where p.plan_id = pl.id), pl.updated_at),
    coalesce((select max(a.created_at) from public.activities a where a.plan_id = pl.id), pl.updated_at))
  from public.plans pl where pl.slug = p_slug;
$$;

-- --- Grants ----------------------------------------------------------------
-- The functions are the entire API surface.

-- Postgres grants EXECUTE to PUBLIC by default, so revoking from `anon` alone
-- leaves a function wide open. Take it away from PUBLIC first, then hand it
-- back only to the roles that should have it.
revoke execute on function
  public.get_plan(text),
  public.create_plan(text, date, date, text, text),
  public.join_plan(text, text),
  public.update_participant(text, uuid, jsonb),
  public.fill_in_for(text, uuid, text, jsonb, jsonb),
  public.set_interest(text, uuid, uuid, text, text),
  public.add_activity(text, uuid, text, text),
  public.archive_activity(text, uuid, uuid),
  public.update_plan(text, uuid, text, date, date),
  public.plan_pulse(text),
  public.shmaybe_apply_patch(uuid, jsonb),
  public.shmaybe_slug(),
  public.shmaybe_plan_id(text),
  public.shmaybe_auth(text, uuid)
from public;

grant execute on function
  public.get_plan(text),
  public.create_plan(text, date, date, text, text),
  public.join_plan(text, text),
  public.update_participant(text, uuid, jsonb),
  public.fill_in_for(text, uuid, text, jsonb, jsonb),
  public.set_interest(text, uuid, uuid, text, text),
  public.add_activity(text, uuid, text, text),
  public.archive_activity(text, uuid, uuid),
  public.update_plan(text, uuid, text, date, date),
  public.plan_pulse(text)
to anon, authenticated;

-- shmaybe_slug / shmaybe_plan_id / shmaybe_auth / shmaybe_apply_patch are
-- deliberately absent from the grant above: they are internals the
-- security-definer functions call, not part of the API surface.
