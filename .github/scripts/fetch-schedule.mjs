// Records every NHL team's regular-season game dates so the History chart's
// "Projected" range can follow the real schedule (no projected points on a
// day with no games) instead of assuming a game every day. The browser can't
// call api-web.nhle.com itself (no CORS headers), so this runs in the daily
// Action and the site just reads data/schedule.json.
//
// Walks the league-wide weekly schedule from the preseason to the end of the
// season (each response says where the next week starts) and keeps only
// regular-season games. Built-in fetch only — no dependencies.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";

const SCHEDULE_URL = "https://api-web.nhle.com/v1/schedule";
const DATA_PATH = "../../data/schedule.json";
const REGULAR_SEASON = 2;
const MAX_WEEKS = 60; // a season is ~27 weeks; a runaway loop stops here

// The season in progress: from July on it's the one starting this year,
// before that the one that started last year (same rule as the Worker's).
const now = new Date();
const startYear = now.getUTCMonth() + 1 >= 7 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
const season = `${startYear}${startYear + 1}`;

async function getJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.json();
}

const gamesByTeam = {};
let weekStart = `${startYear}-09-25`;
for (let weeks = 0; weekStart && weeks < MAX_WEEKS; weeks++) {
  const week = await getJson(`${SCHEDULE_URL}/${weekStart}`);
  for (const day of week.gameWeek || []) {
    for (const game of day.games || []) {
      if (game.gameType !== REGULAR_SEASON || String(game.season) !== season) continue;
      for (const side of ["awayTeam", "homeTeam"]) {
        const abbrev = game[side] && game[side].abbrev;
        if (abbrev) (gamesByTeam[abbrev] = gamesByTeam[abbrev] || []).push(day.date);
      }
    }
  }
  // Past the season's end the API keeps offering weeks (the playoffs, the
  // next season); stop once a whole week is beyond next June.
  const next = week.nextStartDate;
  weekStart = next && next < `${startYear + 1}-07-01` ? next : null;
}

const teams = Object.keys(gamesByTeam).sort();
if (teams.length < 30 || teams.some((t) => gamesByTeam[t].length < 60)) {
  throw new Error(`Schedule looks incomplete (${teams.length} teams) — leaving data/schedule.json as it was.`);
}
for (const team of teams) gamesByTeam[team].sort();

const existing = existsSync(DATA_PATH) ? JSON.parse(readFileSync(DATA_PATH, "utf8")) : {};
existing[season] = Object.fromEntries(teams.map((t) => [t, gamesByTeam[t]]));
mkdirSync(dirname(DATA_PATH), { recursive: true });
writeFileSync(DATA_PATH, JSON.stringify(existing) + "\n");

console.log(`Saved ${teams.length} teams' schedules for ${season} (${gamesByTeam[teams[0]].length} games each, e.g. ${teams[0]}).`);
