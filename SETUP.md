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
