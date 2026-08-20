-- ===========================================================================
-- Shmaybe — migration 2: filling in on someone else's behalf
--
-- Safe to re-run, and safe to run on a database that already has migration 1.
-- Supabase → SQL Editor → New query → paste → Run.
--
-- Why this exists: when you paste a group text thread, you are writing
-- constraints for people who never opened the link. The rule is that you may
-- speak for someone who has not spoken for themselves — the moment they claim
-- their row, only they can edit it.
-- ===========================================================================

-- Shared patch application, so update_participant and fill_in_for cannot drift
-- apart. Also fixes the original's handling of an explicitly emptied array.
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

-- Naming the first activity counts as being up for it (this also lands the
-- create_plan fix, in case it was not applied separately).
create or replace function public.create_plan(
  p_title text, p_start date, p_end date, p_activity text, p_name text)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_slug text; v_plan uuid; v_act uuid; v_part uuid;
  v_token uuid := gen_random_uuid();
begin
  if coalesce(trim(p_title), '') = '' then raise exception 'A plan needs a title'; end if;
  if p_end < p_start then raise exception 'The window ends before it starts'; end if;

  loop
    v_slug := public.shmaybe_slug();
    exit when not exists (select 1 from public.plans where slug = v_slug);
  end loop;

  insert into public.plans (slug, title, window_start, window_end)
  values (v_slug, trim(p_title), p_start, p_end) returning id into v_plan;

  if coalesce(trim(p_activity), '') <> '' then
    insert into public.activities (plan_id, title, proposed_by)
    values (v_plan, trim(p_activity), coalesce(trim(p_name), '')) returning id into v_act;
  end if;

  if coalesce(trim(p_name), '') <> '' then
    insert into public.participants (plan_id, name, claim_token)
    values (v_plan, trim(p_name), v_token) returning id into v_part;
  end if;

  if v_part is not null and v_act is not null then
    insert into public.interests (participant_id, activity_id, level) values (v_part, v_act, 'yes');
  end if;

  return jsonb_build_object('slug', v_slug, 'participantId', v_part, 'token', v_token);
end;
$$;

-- Write constraints for somebody who has not joined. Creates the row if the
-- name is new; refuses outright if they have claimed it.
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

-- Grants. EXECUTE goes to PUBLIC by default, so take it away first.
revoke execute on function
  public.shmaybe_apply_patch(uuid, jsonb),
  public.fill_in_for(text, uuid, text, jsonb, jsonb),
  public.update_participant(text, uuid, jsonb),
  public.create_plan(text, date, date, text, text)
from public;

grant execute on function
  public.fill_in_for(text, uuid, text, jsonb, jsonb),
  public.update_participant(text, uuid, jsonb),
  public.create_plan(text, date, date, text, text)
to anon, authenticated;
-- shmaybe_apply_patch stays internal.
