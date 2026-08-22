# Turning on shared mode

Shmaybe works out of the box, but in **local mode**: the plan lives in one
browser, so it's a demo rather than something you can send to four friends.
Shared mode takes about five minutes.

## 1. Make a Supabase project

<https://supabase.com> → New project. The free tier is far more than enough —
a plan is a few kilobytes.

## 2. Run the schema

Supabase → **SQL Editor** → New query → paste the whole of
[`supabase-schema.sql`](supabase-schema.sql) → **Run**.

It creates four tables and the functions that are the app's entire API. You
should see a run of `CREATE TABLE` / `CREATE FUNCTION` with no errors.

## 3. Paste your keys into `config.js`

Supabase → **Project Settings → API**. Copy the two values:

```js
window.SHMAYBE_CONFIG = {
  SUPABASE_URL: "https://yourproject.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbG...",   // the "anon" / "publishable" key
};
```

Both are safe to commit to a public repo — the anon key is *designed* to ship
in client-side code. **Never put the `service_role` key here.** That one
bypasses every protection below.

Reload the page. The pill in the header should flip from *this browser only*
to *shared*.

## Already have a database from an earlier version?

Run the migrations you're missing, oldest first. Both are safe to re-run, and
if you skip one the app will name the missing function rather than failing
mysteriously.

| File | Adds |
| --- | --- |
| [`supabase-migration-2.sql`](supabase-migration-2.sql) | `fill_in_for()` — the thread reader |
| [`supabase-migration-3.sql`](supabase-migration-3.sql) | `whoami()` / `release_participant()` — getting back into your own row |
| [`supabase-migration-4.sql`](supabase-migration-4.sql) | one level instead of two: the plan is named by its ideas |

Or just re-paste [`supabase-schema.sql`](supabase-schema.sql), which contains
every migration and is safe to run over an existing database — including the
one-time fix that promotes an old plan title into a real idea.

## Getting back into your own row

Your claim token lives in one browser. Three things follow, and each has an
answer on the **You** tab:

- **Same person, another device** — “Open on another device” copies a private
  link with your token in it. Open that on the new phone and you arrive as
  yourself. It's yours, not the group's: anyone holding it edits as you. The
  token is stripped from the address bar as soon as it's used, so it doesn't
  linger in history or screenshots.
- **Wrong name** — “Change name” renames your row in place, keeping every
  constraint. It refuses a name somebody else in the plan already has.
- **Wrong spot entirely** — “Not me” releases it. The row and its answers stay
  on the plan; it just goes back to unclaimed so the right person can take it.
  This matters: simply forgetting a token used to lock that row for everyone,
  permanently.

## Speaking for other people

Pasting a group thread means writing constraints for people who never opened
the link, which the per-person claim token would otherwise forbid. The rule:

> You may speak for someone who has not spoken for themselves — and only until
> they do.

`fill_in_for()` creates or updates a participant **only while their row is
unclaimed**. The moment someone joins, `fill_in_for` refuses and the UI shows
their card as read-only, pointing you at the nudge drafts instead.

## How it's secured without a login

There are no accounts, which means the usual row-level-security-by-user-id
trick isn't available. Instead:

- **The tables are closed.** RLS is on with no policies, and `anon` has no
  grants. A visitor cannot read or write a single row directly — that's
  verified in the tests, where `select count(*) from plans` as `anon` returns
  *permission denied*.
- **Everything goes through security-definer functions**, and every one of them
  requires the plan slug. The slug is 12 random characters from a 30-character
  alphabet — roughly 2×10¹⁷ combinations — so plans can't be enumerated or
  guessed.
- **Editing your own row additionally requires a claim token**, a UUID minted
  when you join and kept in your browser. `get_plan` never returns tokens, so
  reading a plan doesn't let you edit anyone in it.
- **`EXECUTE` is revoked from `PUBLIC`** before being granted to `anon`, because
  Postgres grants it to everyone by default — revoking from `anon` alone leaves
  a function open.

### What this deliberately does *not* protect against

Anyone with the link can **join** the plan and **propose** an activity. That's
the point — you're texting it to friends. Within a plan, people are trusted;
the security boundary is around the plan, not around each person.

One consequence worth knowing: whoever holds a claim token can edit the plan's
title and date window. Any participant can. If that matters for your group,
it's a two-line change in `update_plan` to check the name against the plan's
creator.

## Polling, not realtime

Supabase realtime needs `SELECT` on the tables, which is exactly what's
revoked. So the app polls a cheap `plan_pulse()` every 10 seconds while the tab
is visible, and only re-fetches when something actually changed. For a handful
of people answering over hours, that's indistinguishable from realtime and much
harder to get wrong.

## Running it locally

```bash
python3 -m http.server 4321 --directory .
```

Deploys to GitHub Pages as-is.
