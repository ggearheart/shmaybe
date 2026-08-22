-- ===========================================================================
-- Shmaybe — migration 5: invites, and who may withdraw one
--
-- Safe to re-run. Supabase → SQL Editor → New query → paste → Run.
--
-- Anyone in a plan can bring somebody else in — Val invites Kelly without
-- going through whoever started it. That needs two facts the schema never
-- recorded: who created the plan, and who invited whom.
-- ===========================================================================

alter table public.plans        add column if not exists created_by uuid;
alter table public.participants add column if not exists invited_by uuid;

-- Plans made before this have no recorded creator, so fall back to the first
-- person in the roster — which is exactly who create_plan inserts first.
create or replace function public.shmaybe_owner(p_plan uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select coalesce(
    (select pl.created_by from public.plans pl where pl.id = p_plan),
    (select p.id from public.participants p where p.plan_id = p_plan
      order by p.created_at limit 1));
$$;

create or replace function public.create_plan(
  p_title text, p_start date, p_end date, p_activity text, p_name text)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_slug text; v_plan uuid; v_act uuid; v_part uuid;
  v_token uuid := gen_random_uuid();
  v_name text := coalesce(nullif(trim(p_activity), ''), nullif(trim(p_title), ''));
begin
  if coalesce(v_name, '') = '' then raise exception 'Say what you want to do'; end if;
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
    update public.plans set created_by = v_part where id = v_plan;
  end if;

  return jsonb_build_object('slug', v_slug, 'participantId', v_part, 'token', v_token);
end;
$$;

-- Put a name down for somebody who isn't here yet. Returns the row either way,
-- so inviting the same person twice is harmless rather than an error.
create or replace function public.invite_participant(p_slug text, p_token uuid, p_name text)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_caller uuid := public.shmaybe_auth(p_slug, p_token);
  v_plan   uuid := public.shmaybe_plan_id(p_slug);
  v_part   uuid;
  v_claimed uuid;
begin
  if v_caller is null then raise exception 'Join the plan before inviting anyone'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Who are you inviting?'; end if;

  select id, claim_token into v_part, v_claimed from public.participants
   where plan_id = v_plan and lower(name) = lower(trim(p_name));

  if v_part is null then
    insert into public.participants (plan_id, name, invited_by)
    values (v_plan, trim(p_name), v_caller) returning id into v_part;
    return jsonb_build_object('participantId', v_part, 'name', trim(p_name), 'created', true);
  end if;

  return jsonb_build_object('participantId', v_part, 'name', trim(p_name),
                            'created', false, 'joined', v_claimed is not null);
end;
$$;

-- Withdraw an invite that was never taken up. Only the plan's owner or whoever
-- sent it, and never for somebody who has actually joined — they leave under
-- their own steam with "Not me".
create or replace function public.remove_participant(p_slug text, p_token uuid, p_participant uuid)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_caller uuid := public.shmaybe_auth(p_slug, p_token);
  v_plan   uuid := public.shmaybe_plan_id(p_slug);
  v_target public.participants%rowtype;
begin
  if v_caller is null then raise exception 'Join the plan first'; end if;

  select * into v_target from public.participants
   where id = p_participant and plan_id = v_plan;
  if not found then raise exception 'Nobody by that id in this plan'; end if;

  if v_target.claim_token is not null then
    raise exception '% has joined, so only they can step out', v_target.name
      using errcode = 'insufficient_privilege';
  end if;

  if v_caller <> public.shmaybe_owner(v_plan)
     and v_target.invited_by is distinct from v_caller then
    raise exception 'Only whoever started the plan, or whoever invited %, can withdraw that', v_target.name
      using errcode = 'insufficient_privilege';
  end if;

  delete from public.participants where id = p_participant;
  return jsonb_build_object('ok', true, 'name', v_target.name);
end;
$$;

-- get_plan gains ownership and invite provenance, so the UI knows which
-- withdraw buttons to show.
create or replace function public.get_plan(p_slug text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', pl.id,
    'slug', pl.slug,
    'title', coalesce((
      select a.title from public.activities a
      where a.plan_id = pl.id and not a.archived
      order by a.created_at limit 1), pl.title),
    'ownerId', public.shmaybe_owner(pl.id),
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
               'invitedBy', p.invited_by,
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

revoke execute on function
  public.shmaybe_owner(uuid),
  public.invite_participant(text, uuid, text),
  public.remove_participant(text, uuid, uuid)
from public;

grant execute on function
  public.invite_participant(text, uuid, text),
  public.remove_participant(text, uuid, uuid)
to anon, authenticated;
-- shmaybe_owner stays internal.
