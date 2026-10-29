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
| `team.html` | One team's full roster and per-player stats for a given season, including a "Cost" column showing each player's point total from the prior season (the roster is listed highest cost first, and anyone traded away shows "—" in their usual place). The page picks up the team's color from the "Standings Over Time" chart (`TEAM_COLORS` in `teams.js`, by the team's position in the season's list): the header's divider, a faint wash across the header, a ring on the team's avatar (which gives a quick pop as the page opens), and the line above the totals row. |
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

That's it — commit and push `teams.js`. Everything else picks the new
season up automatically:

- The season dropdown on the Standings page lists whatever seasons
  exist in `TEAMS_BY_SEASON`, and defaults to whichever one sorts last
  — so once you add `20272028`, it becomes the default shown.
- Player stats for that season are fetched from the same season-agnostic
  NHL proxy that already handles every season — no backend changes.
- Live injury status (from ESPN's public feed, since the NHL's own API
  has no injury data) is season-agnostic too. The injury icon's tooltip
  on the team page shows the status, injury type and ESPN's expected
  return date (an estimate — often just a default of about a week when
  nothing more specific has been reported).

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

The chart opens on the range picker's "1 Week" option — the last 7 days
counted back from the newest snapshot — with "1 Month" and "Season" a
dropdown away (the default is the `selected` option in `index.html`).
On 1 Week and 1 Month the y-axis starts near the lowest point in the
window (so it rises as old days slide out of it, and tightens up when
comparing a subset of teams) rather than at 0; Season and Projected stay
anchored at 0. Every view draws just the lines, without a dot on every day
(they clutter it) — each line keeps its logo at the end, and hovering still
picks out a day.

When the site is opened, the chart draws in from left to right with each
team's logo riding the head of its line (about 3 seconds). A logo reacts
on the days its team's position moved — a hop and a sparkle for moving
up, a droop and a tear for moving down, matching the logos in the table.
Once the lines arrive, each logo gets a moment of its own, last place
first: the same mood for how its position changed over the whole range
(with a "▲2"/"▼1" tag), or just a pop if it ended where it started.

It plays only when the site is opened from somewhere else — a typed URL,
a bookmark, a link from elsewhere. Clicking between the site's own pages
(judged by the referrer, `shouldPlayIntro` in `history.js`), going
back/forward, changing the range or season, the background refresh and
the theme toggle don't replay it, and it's skipped for anyone with
reduced motion turned on.

The team page has its own, smaller entrance (`team.js` / the "Team page
entrance" block in `style.css`), also only on the page's first render:
the header's divider draws in from the left and its wash fades up, the
roster rows settle in one after another, every score counts up from 0
(the totals row last, ending with a pop), and anyone with points in
"Tonight" or "Last Night" gets a brief green glow on that number. The
avatar pops on arrival and again whenever it's clicked or tapped — and
if you keep at it (five clicks in a row, each within 0.8s of the last) it
gets angry: red ring, flushed and shaking, with 💢 popping off it. Live
changes while the page is open use the Standings page's goal light (red,
for a goal) and assist light (blue, for an assist only) on the player's
row, and count the score up from what it just was. It's all skipped with
reduced motion, and in a tab that's opened in the background (nobody's
there to see it, and the numbers would otherwise wait at 0).

The range picker's fourth option, "Projected", shows the full season
(like "Season") plus a dashed line per team. It follows the NHL
schedule and each team's *current* roster: from the team's latest
point, every day adds the pace of each active player whose NHL team
has a game that day, out to the last game of the regular season — so
it's flat on a league-wide off day (Christmas, the All-Star break). A
player's pace is their points per game played this season, including
games before they joined the team (so a player acquired in a trade
projects on their own record, and the player traded away adds nothing),
weighted so recent games count more: games are grouped into weeks
counting back from today and each week counts half as much as the one
after it (the stats come from the stats API's `before=` filter, one
request per week boundary — the same filter `app.py` and `worker.js`
use for the live-points handoff). Someone who hasn't played a game
this season adds nothing until they do. Two adjustments follow
availability: a player on the injury report adds nothing until ESPN's
listed return date (and is assumed healthy after it; a date that's
already passed is ignored as stale), and everyone else's pace is scaled
by how many of their team's games they've played, with 20 extra games
"played" as a prior (6 of 12 gives 81%, 30 of 60 gives 63%) so an early
absence barely registers. It's an "if this pace holds" line, not a
simulation — future injuries and trades aren't modeled — recomputed
from scratch on every render, nothing is stored. This option (and the
range picker as a whole) only appears for the current season — it's
hidden for past seasons, which always just show their full history.

The schedule comes from `data/schedule.json` (every NHL team's
regular-season game dates), written by `.github/scripts/fetch-schedule.mjs`
as a step of the same daily workflow — the browser can't call the NHL's
schedule API itself, and games do get postponed, so it's re-read daily.
It's best effort: if that step fails the last good file stays in place,
and if the file's missing, Projected shows just the real lines.

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
- **Leader's crown and rank moods** (Standings page, `standings.js`): the
  leader's logo wears a 👑, and a logo hops (✨) after its team moves up or
  droops (💧) after it moves down — compared against the previous poll, or
  on a fresh load against the ranks this browser last saw (kept in
  `localStorage`; a first visit shows nothing). When the lead itself
  changes hands the crown lifts off the old leader, arcs across the table
  and lands on the new one with a bounce and a little confetti. All off for
  reduced motion. `?preview-moods` and `?preview-crown` replay the moods and
  the hand-off on demand, without waiting for a real change.
- **Trade deadline** (`tradeDeadline` on the season in `teams.js`, e.g.
  `"2027-03-01T15:00:00-05:00"` — 3pm Eastern, so mind the UTC offset if it
  ever falls after daylight saving starts in March): the chart draws
  a dashed amber vertical line on that day with a "Trade deadline" label
  (history.js) in any range it falls inside: always on **Projected**, on
  **Season** and **1 Month** once the deadline has passed (and on a shorter
  range if it's within that window); before then those ranges stop short of
  it, so there's nothing to draw. `deadline.js` shows a dismissible
  banner under the nav on the Standings, Team and Games pages: from a week
  before it says when the deadline is and how many days are left, and on the
  day itself it reminds again — even if the week one was dismissed — until
  3pm Eastern passes. Dismissals are remembered per reminder in
  `localStorage`. `?preview-deadline=week` / `=day` show either banner now.
  Leave `tradeDeadline` out of a season to turn both off.
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
  The team page has the same column per player (after Score, before "Last
  Night") under the same rule — it appears once the night's first game has
  started and steps aside when the player-points snapshot for that night
  lands and "Last Night" reports it — and a team's total there always
  equals its Tonight number on the Standings page.
- **"Last night" recap** (Standings page, `recap.js`): each team's points
  from the most recent night, plus anyone who moved in the standings. It's
  built from the two newest daily snapshots when they cover last night.
  But the snapshot Action usually starts hours late (mid-morning Eastern,
  whatever time it's scheduled for) and can skip a night altogether — so
  when the snapshots don't reach last night, or span more than one night,
  it's built from the live data instead: the standings now with the later
  nights taken back out (using the Worker's per-night `byDate` points and
  the same scoring as the table). That's available from 6am Eastern, when
  "last night" becomes the night that just ended. With no live data (the
  local `app.py`) it falls back to the snapshots, headed "Since <date>"
  rather than "Last night" if they span more than one night. Closing it is
  remembered per night. The team page's "Last Night" column (`team.js`)
  makes the same choice with the same test, and scores the live version
  with the same functions, so a team's column total always equals its
  number in the recap; its header tooltip says which source it used.
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
