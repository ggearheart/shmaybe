-- ===========================================================================
-- Shmaybe — migration 3: getting back into your own row
--
-- Safe to re-run. Supabase → SQL Editor → New query → paste → Run.
--
-- The claim token minted when you join lives only in that browser, which left
-- three things impossible: moving your identity to another device, correcting
-- a name, and letting go of a spot you tapped by mistake. A row whose token
-- was forgotten became permanently uneditable by anyone.
-- ===========================================================================

-- Validate a token and say who it belongs to. Used when adopting a personal
-- link, so a stale or wrong token is rejected up front rather than failing on
-- the first attempted write.
create or replace function public.whoami(p_slug text, p_token uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('participantId', p.id, 'name', p.name)
  from public.participants p
  join public.plans pl on pl.id = p.plan_id
  where pl.slug = p_slug and p.claim_token = p_token;
$$;

-- Let go of a spot. The row and everything on it survives; it just becomes
-- unclaimed, so the right person can take it. This is the honest counterpart
-- to joining: without it, "that's not me" orphaned the row forever.
create or replace function public.release_participant(p_slug text, p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_part uuid := public.shmaybe_auth(p_slug, p_token);
  v_name text;
begin
  if v_part is null then raise exception 'That spot is not yours to release'; end if;
  select name into v_name from public.participants where id = v_part;
  update public.participants set claim_token = null, updated_at = now() where id = v_part;
  return jsonb_build_object('ok', true, 'name', v_name);
end;
$$;

-- Renaming onto a name already in the plan raised a raw constraint violation,
-- SQL text and all. Say it in a sentence instead.
create or replace function public.update_participant(p_slug text, p_token uuid, p_patch jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare v_part uuid := public.shmaybe_auth(p_slug, p_token);
begin
  if v_part is null then raise exception 'Not your row to edit'; end if;
  perform public.shmaybe_apply_patch(v_part, p_patch);
  return jsonb_build_object('ok', true);
exception
  when unique_violation then
    raise exception 'Somebody in this plan is already called %', trim(p_patch->>'name')
      using errcode = 'unique_violation';
end;
$$;

revoke execute on function
  public.whoami(text, uuid),
  public.update_participant(text, uuid, jsonb),
  public.release_participant(text, uuid)
from public;

grant execute on function
  public.whoami(text, uuid),
  public.update_participant(text, uuid, jsonb),
  public.release_participant(text, uuid)
to anon, authenticated;
