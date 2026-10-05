# Tremblay Hockey Pool

A small static site for tracking a fantasy hockey pool: a **Standings**
leaderboard ranking each pool team by the combined season points of its
20 drafted NHL players, a **team detail** page showing that breakdown
per player (with live injury status), and a **Player Selector** for
browsing/filtering NHL skater stats when drafting.

## Pages

| File | What it is |
| --- | --- |
| `index.html` | Standings — the pool leaderboard with a season picker, a "Tonight" column while games are on (see below), plus a "Standings Over Time" line chart |
| `team.html` | One team's full roster and per-player stats for a given season, including a "Cost" column showing each player's point total from the prior season |
| `games.html` | Games — today's and yesterday's regular-season NHL games that include at least one pool player: live score and period, plus each pool player's points in that game with an icon for every pool team that owns them. "Today" is the NHL's own US Eastern date, whatever timezone you're viewing from. Games still to come or in progress also get a "Watch" row of the Canadian networks showing them that reach Southwestern Ontario (see below). |
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
   end year, e.g. `"20272028"` for the 2027-28 season):

   ```js
   const TEAMS_BY_SEASON = {
     "20262027": { teams: [ /* ... */ ], trades: [ /* ... */ ] },
     "20272028": {
       teams: [
         {
           name: "Curtis",
           logo: "images/curtis.svg", // optional — see below
           players: [ /* that team's 20 draft picks */ ],
         },
         { name: "Anmol", players: [ /* ... */ ] },
         // one entry per team playing this season
       ],
       trades: [], // mid-season trades go here as the year plays out — see below
     },
   };
   ```

2. **Team names carry over year to year** for teams that keep playing —
   use the same `name` as previous seasons so history stays linked. A
   team that dropped out simply isn't included that season.

3. **Player names must match the NHL API's exact spelling**, including
   accents (e.g. `"Tim Stützle"`, not an ASCII version). If a name
   doesn't match, nothing breaks — the app shows a small ⚠ next to that
   team with a tooltip naming the player it couldn't find, so typos are
   easy to spot just by loading the page. If instead the ⚠ says
   *multiple* players share that name (it happens — two different NHL
   players can have the exact same name), add `team` and/or `position`
   to that entry to disambiguate: `{ name: "Elias Pettersson", position: "C" }`.

4. Optional: force-flag a player as injured with
   `{ name: "Player Name", injured: true }` instead of a plain string.
   You normally won't need this — injury status is detected
   automatically (see below) — it's just a fallback for anything the
   feed misses.

5. **Mid-season trades** go in that season's `trades` array — see the
   comment block above `TEAMS_BY_SEASON` in `teams.js` for the exact
   format. A trade locks the outgoing player's stats as of the trade
   date and prorates the incoming player's, without needing to remove
   anyone from the `players` list. Cap of two trades per team per
   season isn't enforced in code — just a rule to follow by hand.

6. Optional: give a team a `logo` (a path to an image file, e.g. under
   `images/`). It's used as the marker on that team's most recent point
   in the "Standings Over Time" chart, in place of the default dot —
   any web image format works (PNG/JPG/SVG/etc.), and a missing or
   broken file just falls back to a plain dot rather than erroring.

7. Optional: set `seasonEnd: "YYYY-MM-DD"` on the season object itself
   (alongside `teams`/`trades`) if the default guess of April 15 is off
   for that year. It's only used by the chart's "Show season-end
   projection" option — see below.

That's it — commit and push `teams.js`. Everything else picks the new
season up automatically:

- The season dropdown on the Standings page lists whatever seasons
  exist in `TEAMS_BY_SEASON`, and defaults to whichever one sorts last
  — so once you add `20272028`, it becomes the default shown.
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

## Standings history & chart

The "Standings Over Time" line chart on the Standings page reads from
`data/standings-history.json` — a growing log of daily snapshots, one
entry per day per season, keyed the same way as `TEAMS_BY_SEASON`.

To compare just some teams, use the legend: click a team to show only
its line, then click more teams to add them (click a shown team to
remove it). Clicking the last team left shows everyone again. A team's
dashed projection, if any, follows it.

That file is written automatically by
`.github/workflows/snapshot-standings.yml`, which runs once a day
(and can be triggered manually from the Actions tab — "Snapshot
Standings" → "Run workflow", useful for testing). Rather than
reimplementing the scoring rules (trades, injuries, disambiguation) a
second time, the workflow loads the *real* deployed Standings page with
a headless browser (`.github/scripts/snapshot-standings.mjs`, via
Playwright) and reads the rendered numbers straight out of the page —
so there's only ever one place the scoring logic lives. It then commits
the updated JSON file back to the repo, which GitHub Pages picks up and
redeploys automatically like any other push.

No action needed from you day-to-day — this just runs in the
background. A season needs at least two days of snapshots before the
chart shows a line; until then it shows a placeholder message instead.

The range picker's fourth option, "Projected", shows the full season
(like "Season") plus a dashed line per team: a linear trend fit
through that team's season-to-date snapshots — weighted so recent
snapshots count more than older ones (each day further back counts
for half as much every 7 days) — extrapolated out to that season's
`seasonEnd` (see step 7 above). It's a "if this recent pace holds"
line, not a simulation — recomputed from scratch on every render,
nothing is stored. This option (and the range picker as a whole) only
appears for the current season — it's hidden for past seasons, which
always just show their full history.

## Architecture notes

- **Backend proxy**: `app.py` (local dev) and `worker.js` (deployed to
  Cloudflare Workers) both proxy the NHL's APIs, which send no CORS
  headers so the browser can't call them directly. Season stats
  (`/api/players`, from `api.nhle.com`) are cached for 5 minutes; live
  game data for the Games page (`/api/scores?date=YYYY-MM-DD` and
  `/api/boxscore?id=<gameId>`, from `api-web.nhle.com`) is cached for
  only 30 seconds. `worker.js` is deployed by hand, so after changing it
  paste the new version into the Cloudflare dashboard again — the site
  on GitHub Pages won't see new routes until you do.
- **Client-side caching**: `common.js` caches the full-season roster
  and injury data in `sessionStorage` for 5 minutes, shared across all
  pages in the same tab session.
- **Live polling**: Standings and team pages auto-refresh every 60
  seconds while the tab is visible — cheap, since the actual network
  fetch only happens when the 5-minute cache above has expired. The Games
  page polls on the same schedule; each poll refetches the two days'
  scoreboards and the box scores of games still in progress, while a
  finished game's box score is only fetched once per page load.
- **"Tonight" column**: each team's points from the current night's
  games only (the Worker's `/api/live` splits every player's live points
  by game date, so one night's points can be told from another's). It
  appears once the night's first game has started and stays up after the
  games end, until the nightly snapshot lands — at that point the recap
  banner reports the same night and the column hides until the next
  night's first game starts. A night runs on the NHL's US Eastern game
  date and rolls over at 6am Eastern, so late games finishing after
  midnight still count toward that evening. It needs `/api/live`, so it
  only shows when deployed (the local `app.py` doesn't have that route).
- **Where to watch** (Games page): each game's Canadian TV listings come
  from the NHL's own score feed (`tvBroadcasts`), so there's no extra
  request or Worker change. `games.js`'s `WATCH_NETWORKS` /
  `NOT_WATCHABLE` tables decide which of those reach Southwestern Ontario
  — national Sportsnet, Sportsnet+, Prime and TSN4 (the Maple Leafs'
  regional feed) — and drop other regions' feeds (SNW/SNP/SNE,
  TSN2/3/5) and the French-language ones; edit those two tables to
  change the region or add a network. If nothing reaches Southwestern
  Ontario, the row switches to "Elsewhere" and shows the broadcasts the
  NHL lists for other regions (other Canadian regions, the US, French
  feeds), dimmed, closest first — hover or tap one for its source and
  region (e.g. "Sportsnet West — Western Canada"). The NHL has logos for
  Sportsnet, Prime and the big US streamers but not TSN or the regional
  sports networks, which get a text badge showing the NHL's own network
  code (only the unambiguous ones are expanded to a full name, in
  `NETWORK_NAMES`). The feed can't say anything about blackouts or which
  TV package you have, so it's a best guess, not a guarantee.
- **Daily snapshots**: see "Standings history & chart" above —
  a scheduled GitHub Action, not anything running on Cloudflare or
  GitHub Pages itself (neither can run code on a schedule).
