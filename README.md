# Tremblay Hockey Pool

A small static site for tracking a fantasy hockey pool: a **Standings**
leaderboard ranking each pool team by the combined season points of its
20 drafted NHL players, a **team detail** page showing that breakdown
per player (with live injury status), and a **Player Selector** for
browsing/filtering NHL skater stats when drafting.

## Pages

| File | What it is |
| --- | --- |
| `index.html` | Standings — the pool leaderboard, with a season picker |
| `team.html` | One team's full roster and per-player stats for a given season |
| `players.html` | Browse/search/sort/filter all NHL skaters for a season |

Shared logic lives in `common.js` (NHL data fetching + caching) and
`teams.js` (the pool's own team/roster data).

## Running locally

```bash
python app.py
```

Then open `http://localhost:8000`. `app.py` serves these static files and
proxies NHL API calls (see "Architecture notes" below).

## Adding a new season

Each year's pool draft is a new entry in `TEAMS_BY_SEASON` inside
**`teams.js`** — that's the only file you need to touch.

1. Add a new key for the season (NHL's season id format: start year +
   end year, e.g. `"20262027"` for the 2026-27 season):

   ```js
   const TEAMS_BY_SEASON = {
     "20242025": [ /* ... */ ],
     "20252026": [ /* ... */ ],
     "20262027": [
       { name: "Ice Breakers", players: [ /* that team's 20 draft picks */ ] },
       { name: "Blue Line Bandits", players: [ /* ... */ ] },
       // one entry per team playing this season
     ],
   };
   ```

2. **Team names carry over year to year** for teams that keep playing —
   use the same `name` as previous seasons so history stays linked. A
   team that dropped out simply isn't included that season.

3. **Player names must match the NHL API's exact spelling**, including
   accents (e.g. `"Tim Stützle"`, not an ASCII version). If a name
   doesn't match, nothing breaks — the app shows a small ⚠ next to that
   team with a tooltip naming the player it couldn't find, so typos are
   easy to spot just by loading the page.

4. Optional: force-flag a player as injured with
   `{ name: "Player Name", injured: true }` instead of a plain string.
   You normally won't need this — injury status is detected
   automatically (see below) — it's just a fallback for anything the
   feed misses.

That's it — commit and push `teams.js`. Everything else picks the new
season up automatically:

- The season dropdown on the Standings page lists whatever seasons
  exist in `TEAMS_BY_SEASON`, and defaults to whichever one sorts last
  — so once you add `20262027`, it becomes the default shown.
- Player stats for that season are fetched from the same season-agnostic
  NHL proxy that already handles every season — no backend changes.
- Live injury status (from ESPN's public feed, since the NHL's own API
  has no injury data) is season-agnostic too.

**What you don't need to touch:** `app.py` / `worker.js`, or anything in
`standings.js` / `team.js` — all written to be season-agnostic already.
The one thing that *is* separate: the Player Selector's own default
season flips automatically every October 1st (see `current_season_id()`
in `app.py`/`worker.js`) — that's unrelated to the pool's own season
list and needs no manual update either.

Until you add the new season's entry, the Standings page just keeps
showing the last season you added — nothing errors, it simply goes
stale until updated.

## Architecture notes

- **Backend proxy**: `app.py` (local dev) and `worker.js` (deployed to
  Cloudflare Workers) both proxy `api.nhle.com`, which sends no CORS
  headers so the browser can't call it directly. Both cache responses
  for 5 minutes.
- **Client-side caching**: `common.js` caches the full-season roster
  and injury data in `sessionStorage` for 5 minutes, shared across all
  pages in the same tab session.
- **Live polling**: Standings and team pages auto-refresh every 60
  seconds while the tab is visible — cheap, since the actual network
  fetch only happens when the 5-minute cache above has expired.
