# Shmaybe

*Maybe, shmaybe.* A scheduling aid for the awkward middle of planning a group
trip: you've texted five people, they've each replied with a different flavour
of "yes, but…", and now you have to hold all of it in your head at once.

This holds it for you.

**No accounts, no logins.** You text one link. Everyone opens it on their own
phone, says what they're up for, and puts in when they can go — in pickers, in
plain English, or both. See [SETUP.md](SETUP.md) to switch on shared mode;
without it the app still runs, but in one browser only.

## How it works

It models planning as a staged constraint search rather than a poll:

1. **Interest, per idea** — a plan can hold several competing activities.
   Everyone marks themselves in / maybe / out on each one. Only in and maybe
   constrain the search; an "out" stops costing you dates.
2. **Availability, once** — which weekdays work, dates you're out, a short list
   of dates that *do* work, how much notice you need. You give this a single
   time and it applies to every idea.
3. **Plain English** — type it the way you'd text it and hit **Read it &
   suggest**. The parser proposes constraints as chips you tap to accept, and
   never applies anything on its own.
4. **Inclusivity scoring** — every date is scored by who can make it, with a
   *maybe* weighted less than a *yes*. Tap any date to see who's out and why.

## The parts that do the thinking

- **Which idea travels furthest** — the same people and the same calendar,
  scored against each activity. Answers "we couldn't all make the kayak, but
  all five can do the hike" — a fact about appetite, not about dates. Anyone in
  the plan can float an alternative, and it gets scored against the rest.
- **What would unlock more** — the opposite of a blackout. "I could do a Monday
  if someone can carpool" isn't a constraint, it's an *offer*: it names a job
  that, if somebody does it, turns a 3-of-4 date into a 4-of-4. Shmaybe
  collects those and hands you the list, and the parser can tell one from the
  other inside a single sentence.
- **Read a thread** — people answer by text whether or not you send them a
  link, so paste the group conversation in (or a screenshot of it) and Shmaybe
  splits it by speaker, matches names against the roster, and pulls each
  person's constraints out. OCR runs in the browser, and bubble alignment gives
  speaker attribution for free — your messages sit right, everyone else's sit
  left. Nothing is uploaded, and every line goes through a review step before a
  single constraint is applied.
- **Which weekday to chase** — rolls every date up by weekday, so you can see
  that Saturdays top out at 4 of 5 before you ask anyone about a specific
  Saturday.
- **Who is costing you dates** — flags *sole blockers*: dates where everyone
  else was free. This turns a vague "can anyone be flexible?" into a specific,
  easy text to one person.
- **Or run it twice** — when no single date catches everyone, finds the pair of
  dates that together reach the most people.
- **Ask** — drafts the actual SMS for whatever round you're on, including a
  targeted nudge to whoever is blocking the most dates.

## What the parser understands

| You type | It suggests |
| --- | --- |
| `yes, but only Saturdays work here` | yes · Saturday only |
| `maybe, my partner can only do Mondays and Wednesdays` | maybe · Monday & Wednesday only |
| `in! just need two weeks notice for the sitter` | yes · needs 14 days notice |
| `maybe — weekends or Fridays, and not the week of the 14th` | maybe · Sun/Fri/Sat only · block Sep 13–19 |
| `yeah I'm in, but no Tuesdays or Thursdays` | yes · no Tuesday & Thursday |
| `sure — I'm away Sept 12` | yes · block Sat Sep 12 |
| `maybe? Sept 19 or Sept 26 could work` | maybe · only those two dates |
| `only Saturdays, but I could do a Monday if we start after 5` | Saturday only **and** an offer: Mondays, if we start after 5 |

| `yes! but only if it's not the week of the 14th` | blackout for that week — **not** an offer |

The last two rows are the interesting ones. A conditional clause reverses the
meaning of everything inside it — treating that "Monday" as a restriction would
be exactly backwards — so clauses are classified before their weekdays are
read. But `only if` and `if not…` are restrictions wearing a conditional's
clothes, and reading those as offers would invent a yes nobody gave.

Ambiguous date mentions offer both readings ("only that date" / "block that
date") rather than guessing.

## Running it

It's static — open `index.html`, or serve the folder:

```bash
python3 -m http.server 4321 --directory .
```

Deploys to GitHub Pages as-is (`.nojekyll` is already here). Live at
<https://ggearheart.github.io/shmaybe/>.

## Layout

| File | What's in it |
| --- | --- |
| `js/dates.js` | Local-time `YYYY-MM-DD` helpers — no UTC, so no off-by-one days |
| `js/solver.js` | Scoring, weekday rollup, blocker analysis, split-trip search. Pure functions, no DOM |
| `js/parse.js` | Free text → suggested constraints |
| `js/thread.js` | Splits a pasted conversation by speaker; matches names to the roster |
| `js/ocr.js` | Screenshot → positioned text → transcript. Loads Tesseract lazily |
| `js/api.js` | Picks a driver; also remembers who you are, per plan |
| `js/drivers/supabase.js` | The shared backend. Every call is an RPC |
| `js/drivers/local.js` | The same API over localStorage, for demos and tests |
| `js/app.js` | Rendering and events |
| `supabase-schema.sql` | Tables, and the functions that are the whole API |
