// Records every skater's season totals (points, games played) as of each
// weekly cut-off the Projected chart's pace uses (see history.js's
// paceBoundaries), into data/pace-totals.json — so the site reads one small
// static file instead of making a full-roster Worker request per week every
// time someone opens the Projected range. A cut-off's totals ("games before
// this date") never change once it's passed, so each one is fetched once
// and kept; only the newest is re-fetched every run, in case the stats API
// hadn't finished catching up on the day before it the first time.
// Built-in fetch only — no dependencies.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";

const DATA_PATH = "../../data/pace-totals.json";
const STATS_URL = "https://api.nhle.com/stats/rest/en/skater/summary";

// Keep in sync with history.js (PACE_WINDOWS / paceBoundaries).
const PACE_WINDOWS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

// "YYYY-MM-DD" in US Eastern time — the calendar NHL games are filed under.
export function easternDate(moment = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(moment)
      .map((p) => [p.type, p.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// The last PACE_WINDOWS Mondays on or before `today`, newest first.
export function paceBoundaries(today) {
  const t = Date.parse(`${today}T00:00:00Z`);
  const daysSinceMonday = (new Date(t).getUTCDay() + 6) % 7;
  const monday = t - daysSinceMonday * DAY_MS;
  return Array.from({ length: PACE_WINDOWS }, (_, i) => new Date(monday - i * 7 * DAY_MS).toISOString().slice(0, 10));
}

// The season in progress — same rule as fetch-schedule.mjs and the Worker.
export function seasonInProgress(now = new Date()) {
  const startYear = now.getUTCMonth() + 1 >= 7 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  return `${startYear}${startYear + 1}`;
}

// playerId -> [points, gamesPlayed] for games before `date`.
async function fetchTotalsBefore(season, date) {
  const params = new URLSearchParams({
    isAggregate: "false",
    isGame: "false",
    sort: JSON.stringify([{ property: "playerId", direction: "ASC" }]),
    start: "0",
    limit: "-1",
    factCayenneExp: "gamesPlayed>=1",
    cayenneExp: `gameTypeId=2 and seasonId=${season} and gameDate<"${date}"`,
  });
  const res = await fetch(`${STATS_URL}?${params}`, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`NHL stats API returned ${res.status} for ${date}`);
  const data = await res.json();
  const rows = data.data || [];
  if (rows.length !== data.total) throw new Error(`Partial response for ${date}: ${rows.length} of ${data.total}`);
  return Object.fromEntries(rows.map((p) => [p.playerId, [p.points, p.gamesPlayed]]));
}

// Returns the updated file contents: needed cut-offs filled in (the newest
// always refreshed), anything older than the oldest needed one dropped.
// Cut-offs before the season's first game are left out (nothing to record;
// history.js treats those as zero without asking).
export async function updatePaceTotals(existing, season, today, firstGameDate, fetchTotals = fetchTotalsBefore) {
  const sameSeason = existing && existing.season === season ? existing : null;
  const boundaries = paceBoundaries(today);
  const next = { season, boundaries: {} };
  for (const [i, date] of boundaries.entries()) {
    if (firstGameDate && date <= firstGameDate) continue;
    const kept = sameSeason && sameSeason.boundaries && sameSeason.boundaries[date];
    next.boundaries[date] = kept && i > 0 ? kept : await fetchTotals(season, date);
  }
  return next;
}

// ---- Run (skipped when imported for testing) ----
if (typeof process !== "undefined" && process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop())) {
  const season = seasonInProgress();
  const schedule = existsSync("../../data/schedule.json") ? JSON.parse(readFileSync("../../data/schedule.json", "utf8")) : {};
  const firstGameDate = Object.values(schedule[season] || {}).flat().sort()[0] || null;
  if (!firstGameDate) {
    console.log(`No schedule for ${season} yet — nothing to record.`);
    process.exit(0);
  }
  const existing = existsSync(DATA_PATH) ? JSON.parse(readFileSync(DATA_PATH, "utf8")) : null;
  const updated = await updatePaceTotals(existing, season, easternDate(), firstGameDate);
  mkdirSync("../../data", { recursive: true });
  writeFileSync(DATA_PATH, JSON.stringify(updated) + "\n");
  console.log(`Pace totals for ${season}: ${Object.keys(updated.boundaries).join(", ") || "(none yet)"}.`);
}
