// Loads the real, live Standings page with a headless browser and reads
// the rendered numbers straight out of the DOM — rather than
// reimplementing the scoring rules (trades, injuries, name
// disambiguation) a second time in Node. That logic already lives in
// teams.js/standings.js and runs for real when the page loads; this
// just runs it once a day and records the result.
import { chromium } from "playwright";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";

const SITE_URL = "https://curttree.github.io/hockeypool/";
const DATA_PATH = "../../data/standings-history.json";
// Every skater's season point total as of each snapshot, keyed by NHL
// playerId (stable across name changes). The team page's "Last Night"
// column is the latest snapshot minus the one before it, so only the
// two most recent are kept per season to keep the file small.
const PLAYER_POINTS_PATH = "../../data/player-points.json";
const PLAYER_POINTS_KEEP = 2;

async function captureSnapshot() {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(SITE_URL, { waitUntil: "networkidle" });
    await page.waitForSelector("#standings-table:not([hidden])", { timeout: 45000 });

    const season = await page.$eval("#season", (el) => el.value);
    const standings = await page.$$eval("#standings-table tbody tr", (rows) =>
      rows.map((tr) => ({
        team: tr.querySelector("td.team-name a").textContent.trim(),
        score: parseInt(tr.querySelector("td.score").textContent.replace(/,/g, ""), 10),
      }))
    );

    // Reuses the page's own roster fetch (common.js) rather than calling
    // the API separately. Players with 0 points are left out — a missing
    // id just means 0.
    const playerPoints = await page.evaluate(async (s) => {
      const roster = await fetchAllPlayersForSeason(s);
      return Object.fromEntries(roster.filter((p) => p.points > 0).map((p) => [p.playerId, p.points]));
    }, season);

    return { season, standings, playerPoints };
  } finally {
    await browser.close();
  }
}

function loadJson(path) {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8"));
}

function saveJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

// Adds the entry for entry.date to a date-sorted array, replacing any
// existing one — re-running the same day (e.g. manual dispatch)
// overwrites, doesn't duplicate.
function upsertByDate(entries, entry) {
  const existingIndex = entries.findIndex((e) => e.date === entry.date);
  if (existingIndex >= 0) entries[existingIndex] = entry;
  else entries.push(entry);
  entries.sort((a, b) => a.date.localeCompare(b.date));
}

const { season, standings, playerPoints } = await captureSnapshot();
if (!standings.length) {
  throw new Error("Scraped zero teams from the standings table — page likely didn't render as expected.");
}

// This runs early morning (see the workflow's cron), capturing the result
// of the previous day's games — so the snapshot is tagged with yesterday's
// date, not the date the action happens to be running on.
const runTime = new Date();
runTime.setUTCDate(runTime.getUTCDate() - 1);
const snapshotDate = runTime.toISOString().slice(0, 10);

const history = loadJson(DATA_PATH);
if (!history[season]) history[season] = [];
upsertByDate(history[season], { date: snapshotDate, standings });
saveJson(DATA_PATH, history);

const pointsHistory = loadJson(PLAYER_POINTS_PATH);
if (!pointsHistory[season]) pointsHistory[season] = [];
upsertByDate(pointsHistory[season], { date: snapshotDate, points: playerPoints });
pointsHistory[season] = pointsHistory[season].slice(-PLAYER_POINTS_KEEP);
saveJson(PLAYER_POINTS_PATH, pointsHistory);

console.log(
  `Snapshotted ${standings.length} teams and ${Object.keys(playerPoints).length} scoring skaters ` +
  `for season ${season} on ${snapshotDate}.`
);
