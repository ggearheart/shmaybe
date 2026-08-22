-- ===========================================================================
-- Shmaybe — migration 4: one level, not two
--
-- Safe to re-run. Supabase → SQL Editor → New query → paste → Run.
--
-- A plan used to have a name of its own *and* a list of activities, which made
-- people invent a container ("September outing") for a thing they already had a
-- name for ("kayak to see the bats"). The container is gone: a plan is its
-- ideas. The first one names it; the rest are alternatives to it.
--
-- plans.title survives as the fallback for plans that predate this, but nothing
-- writes to it after creation and nothing displays it when an activity exists.
-- ===========================================================================

-- --- Display name is now derived, so renaming an idea renames the plan -----
create or replace function public.get_plan(p_slug text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', pl.id,
    'slug', pl.slug,
    -- The oldest surviving idea is the anchor: it's what started this, and it
    -- doesn't shuffle when a newer alternative scores better.
    'title', coalesce((
      select a.title from public.activities a
      where a.plan_id = pl.id and not a.archived
      order by a.created_at limit 1), pl.title),
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

-- --- Creating a plan means naming a thing to do ---------------------------
create or replace function public.create_plan(
  p_title text, p_start date, p_end date, p_activity text, p_name text)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_slug text; v_plan uuid; v_act uuid; v_part uuid;
  v_token uuid := gen_random_uuid();
  -- p_title is vestigial: older clients sent a container name. The idea wins.
  v_name text := coalesce(nullif(trim(p_activity), ''), nullif(trim(p_title), ''));
begin
  if coalesce(v_name, '') = '' then
    raise exception 'Say what you want to do';
  end if;
  if p_end < p_start then raise exception 'The window ends before it starts'; end if;

  loop
    v_slug := public.shmaybe_slug();
    exit when not exists (select 1 from public.plans where slug = v_slug);
  end loop;

  insert into public.plans (slug, title, window_start, window_end)
  values (v_slug, v_name, p_start, p_end) returning id into v_plan;

  insert into public.activities (plan_id, title, proposed_by)
  values (v_plan, v_name, coalesce(trim(p_name), '')) returning id into v_act;

  if coalesce(trim(p_name), '') <> '' then
    insert into public.participants (plan_id, name, claim_token)
    values (v_plan, trim(p_name), v_token) returning id into v_part;
    insert into public.interests (participant_id, activity_id, level)
    values (v_part, v_act, 'yes');
  end if;

  return jsonb_build_object('slug', v_slug, 'participantId', v_part, 'token', v_token);
end;
$$;

-- --- Ideas grow after they're proposed ------------------------------------
create or replace function public.update_activity(
  p_slug text, p_token uuid, p_activity uuid, p_title text, p_detail text)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_part uuid := public.shmaybe_auth(p_slug, p_token);
  v_name text;
begin
  if v_part is null then raise exception 'Join the plan first'; end if;
  select name into v_name from public.participants where id = v_part;

  update public.activities set
    title  = coalesce(nullif(trim(p_title), ''), title),
    detail = coalesce(p_detail, detail)
  where id = p_activity
    and plan_id = public.shmaybe_plan_id(p_slug)
    -- An idea nobody claims (promoted from an old plan title) belongs to the
    -- plan, so anyone in it can tend it.
    and (proposed_by = v_name or coalesce(proposed_by, '') = '');

  if not found then raise exception 'Only the person who proposed it can edit it'; end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- --- The window is all that's left of "plan settings" ---------------------
create or replace function public.update_window(p_slug text, p_token uuid, p_start date, p_end date)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare v_part uuid := public.shmaybe_auth(p_slug, p_token);
begin
  if v_part is null then raise exception 'Join the plan first'; end if;
  if p_end < p_start then raise exception 'The window ends before it starts'; end if;
  update public.plans set window_start = p_start, window_end = p_end, updated_at = now()
   where slug = p_slug;
  return jsonb_build_object('ok', true);
end;
$$;

-- --- Never leave a plan with nothing in it --------------------------------
create or replace function public.archive_activity(p_slug text, p_token uuid, p_activity uuid)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_part uuid := public.shmaybe_auth(p_slug, p_token);
  v_plan uuid := public.shmaybe_plan_id(p_slug);
  v_name text;
begin
  if v_part is null then raise exception 'Not yours to retire'; end if;
  if (select count(*) from public.activities where plan_id = v_plan and not archived) <= 1 then
    raise exception 'That is the only idea here — put up another before retiring it';
  end if;
  select name into v_name from public.participants where id = v_part;

  update public.activities set archived = true
   where id = p_activity and plan_id = v_plan
     and (proposed_by = v_name or coalesce(proposed_by, '') = '');

  if not found then raise exception 'Only the person who proposed it can retire it'; end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- --- One-time data fix: give title-only plans a real idea ------------------
-- A plan whose name never became an activity had nothing to be in or out of.
-- Its title *was* the idea, so promote it — and count everyone who already
-- filled in their availability as in, because giving your dates for a thing
-- called "Bat paddle" is how you say yes to a bat paddle.
do $$
declare r record; v_act uuid;
begin
  for r in
    select pl.id, pl.title from public.plans pl
    where not exists (select 1 from public.activities a where a.plan_id = pl.id and not a.archived)
      and coalesce(trim(pl.title), '') <> ''
  loop
    insert into public.activities (plan_id, title, proposed_by)
    values (r.id, r.title, '') returning id into v_act;

    insert into public.interests (participant_id, activity_id, level)
    select p.id, v_act, 'yes' from public.participants p
    where p.plan_id = r.id
      and (p.claim_token is not null or p.weekdays <> '{}' or p.blackouts <> '{}'
           or p.notice_days > 0 or coalesce(p.note, '') <> '')
    on conflict do nothing;

    raise notice 'Promoted plan title % to an idea', r.title;
  end loop;
end $$;

-- --- Grants ---------------------------------------------------------------
revoke execute on function
  public.update_activity(text, uuid, uuid, text, text),
  public.update_window(text, uuid, date, date)
from public;

grant execute on function
  public.update_activity(text, uuid, uuid, text, text),
  public.update_window(text, uuid, date, date)
to anon, authenticated;
