// Saves the most recently completed NHL season's skater totals as a static
// file, data/season-<id>.json, if it isn't there yet. The site loads a
// finished season from that file (see common.js's fetchCompletedSeason)
// instead of through the Worker, which was the slowest request on every
// page load. A finished season never changes, so this only ever writes a
// file once — the first run after a season wraps up.
import { existsSync, writeFileSync, mkdirSync } from "fs";

// Same fields common.js keeps (SEASON_FILE_FIELDS).
const FIELDS = ["playerId", "skaterFullName", "lastName", "teamAbbrevs", "positionCode", "gamesPlayed", "goals", "assists", "points"];

// NHL seasons are over by July — same rule as worker.js's lastCompletedSeasonId.
function lastCompletedSeasonId() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const [start, end] = now.getUTCMonth() + 1 >= 7 ? [year - 1, year] : [year - 2, year - 1];
  return `${start}${end}`;
}

const season = lastCompletedSeasonId();
const path = `../../data/season-${season}.json`;
if (existsSync(path)) {
  console.log(`data/season-${season}.json already exists — nothing to do.`);
  process.exit(0);
}

const params = new URLSearchParams({
  isAggregate: "false",
  isGame: "false",
  sort: JSON.stringify([{ property: "skaterFullName", direction: "ASC" }, { property: "playerId", direction: "ASC" }]),
  start: "0",
  limit: "-1",
  factCayenneExp: "gamesPlayed>=1",
  cayenneExp: `gameTypeId=2 and seasonId=${season}`,
});
const res = await fetch(`https://api.nhle.com/stats/rest/en/skater/summary?${params}`, {
  headers: { "User-Agent": "Mozilla/5.0" },
});
if (!res.ok) throw new Error(`NHL stats API returned ${res.status}`);
const data = await res.json();
const players = (data.data || []).map((p) => Object.fromEntries(FIELDS.map((k) => [k, p[k]])));
// A partial or empty response would be saved forever, so refuse it.
if (players.length < 500 || players.length !== data.total) {
  throw new Error(`Unexpected response: ${players.length} players of ${data.total}`);
}

mkdirSync("../../data", { recursive: true });
writeFileSync(path, JSON.stringify({ season, players }) + "\n");
console.log(`Saved ${players.length} players to data/season-${season}.json.`);
