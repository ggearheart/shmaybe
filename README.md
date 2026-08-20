# Can You Join?

A scheduling aid for the awkward middle of planning a group trip: you've texted
five people, they've each replied with a different flavour of "yes, but…", and
now you have to hold all of it in your head at once.

This holds it for you.

**No accounts, no server, no signup links.** You keep texting people the way you
already do; you type what they said into the app. Everything lives in your
browser's local storage. Export to JSON if you want it on another device.

## How it works

It models planning as a staged constraint search rather than a poll:

1. **Interest gate** — mark each person yes / maybe / no / unanswered. Only yes
   and maybe constrain the search; a "no" stops costing you dates.
2. **Constraint capture** — per person: which weekdays work, specific dates
   they're out, a short list of dates that *do* work, and how much advance
   notice they need. Paste what they actually texted and hit
   **Read it & suggest**; the parser proposes constraints as chips you tap to
   accept. It never applies anything on its own.
3. **Hypothesis testing** — before you send another text, check whether a
   pattern is even worth asking about ("are Saturdays viable at all?"). Every
   test is logged, so you don't burn the same question twice.
4. **Inclusivity scoring** — every date in the window is scored by who can make
   it, with a *maybe* weighted less than a *yes*. Tap any date to see who's out
   and why.

## The parts that do the thinking

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

Ambiguous date mentions offer both readings ("only that date" / "block that
date") rather than guessing.

## Running it

It's static — open `index.html`, or serve the folder:

```bash
python3 -m http.server 4321 --directory .
```

Deploys to GitHub Pages as-is (`.nojekyll` is already here).

## Layout

| File | What's in it |
| --- | --- |
| `js/dates.js` | Local-time `YYYY-MM-DD` helpers — no UTC, so no off-by-one days |
| `js/solver.js` | Scoring, weekday rollup, blocker analysis, split-trip search. Pure functions, no DOM |
| `js/parse.js` | Free text → suggested constraints |
| `js/store.js` | localStorage, import/export |
| `js/app.js` | Rendering and events |
