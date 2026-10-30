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
const AWARDS_PAGE_URL = `${SITE_URL}awards.html`;
const DATA_PATH = "../../data/standings-history.json";
// Every skater's season point total as of each snapshot, keyed by NHL
// playerId (stable across name changes). The team page's "Last Night"
// column is the latest snapshot minus the one before it, so only the
// two most recent are kept per season to keep the file small.
const PLAYER_POINTS_PATH = "../../data/player-points.json";
const PLAYER_POINTS_KEEP = 2;
// The weekly awards (see awards.js): one entry per finished week, handed out
// by the Sunday-morning run, which closes the week ending the day before.
const AWARDS_PATH = "../../data/weekly-awards.json";
// Each day's injury report, for the pool's players only (nothing else
// records past reports), keyed by player name as written in teams.js. Only
// the last couple of weeks are kept — the weekly awards, which are what
// use it, are saved separately once worked out.
const INJURIES_PATH = "../../data/injury-history.json";
const INJURIES_KEEP = 14;

// This runs early morning (see the workflow's cron), capturing the result
// of the previous day's games — so the snapshot is tagged with yesterday's
// date, not the date the action happens to be running on.
const runTime = new Date();
runTime.setUTCDate(runTime.getUTCDate() - 1);
const snapshotDate = runTime.toISOString().slice(0, 10);

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

    // Today's injury report, narrowed to the pool's players. ESPN being down
    // gives an empty report — treated as "no report", not "nobody's hurt".
    let injuries = null;
    try {
      injuries = await page.evaluate(async (s) => {
        const report = await fetchInjuries();
        if (!report.size) return null;
        const hurt = {};
        getTeamsForSeason(s).forEach((team) => team.players.forEach((entry) => {
          const name = playerName(entry);
          const hit = report.get(normalizePlayerName(name));
          if (hit) hurt[name] = { status: hit.status, type: hit.type, returnDate: hit.returnDate };
        }));
        return hurt;
      }, season);
    } catch (err) {
      console.warn(`Couldn't read the injury report: ${err.message}`);
    }

    // On the Sunday-morning run (a Saturday snapshot) the week is over: work
    // out its awards in the Awards page (which has awards.js), with the
    // rosters, trades and injury report to hand. Best-effort — the snapshot
    // matters more.
    let weekAwards = null;
    if (new Date(`${snapshotDate}T12:00:00Z`).getUTCDay() === 6) {
      try {
        const seasonHistory = loadJson(DATA_PATH)[season] || [];
        const weekStart = new Date(Date.parse(snapshotDate) - 6 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const before = seasonHistory.filter((e) => e.date < weekStart).pop();
        await page.goto(AWARDS_PAGE_URL, { waitUntil: "networkidle" });
        weekAwards = await page.evaluate(
          async (args) => (typeof buildWeeklyAwards === "function"
            ? buildWeeklyAwards(args.season, args.weekEnd, args.previous, args.current, {
              // The report just saved, if there is one, else a fresh read.
              injuries: args.injuries ? new Map(Object.keys(args.injuries).map((name) => [normalizePlayerName(name), {}])) : true,
              firstDate: args.firstDate,
            })
            : null),
          {
            season,
            weekEnd: snapshotDate,
            previous: before ? before.standings : null,
            current: standings,
            injuries,
            firstDate: seasonHistory.length ? seasonHistory[0].date : snapshotDate,
          }
        );
      } catch (err) {
        console.warn(`Couldn't work out the weekly awards: ${err.message}`);
      }
    }

    return { season, standings, playerPoints, injuries, weekAwards };
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

const { season, standings, playerPoints, injuries, weekAwards } = await captureSnapshot();
if (!standings.length) {
  throw new Error("Scraped zero teams from the standings table — page likely didn't render as expected.");
}

const history = loadJson(DATA_PATH);
if (!history[season]) history[season] = [];
upsertByDate(history[season], { date: snapshotDate, standings });
saveJson(DATA_PATH, history);

const pointsHistory = loadJson(PLAYER_POINTS_PATH);
if (!pointsHistory[season]) pointsHistory[season] = [];
upsertByDate(pointsHistory[season], { date: snapshotDate, points: playerPoints });
pointsHistory[season] = pointsHistory[season].slice(-PLAYER_POINTS_KEEP);
saveJson(PLAYER_POINTS_PATH, pointsHistory);

if (injuries) {
  const injuryHistory = loadJson(INJURIES_PATH);
  if (!injuryHistory[season]) injuryHistory[season] = [];
  upsertByDate(injuryHistory[season], { date: snapshotDate, injuries });
  injuryHistory[season] = injuryHistory[season].slice(-INJURIES_KEEP);
  saveJson(INJURIES_PATH, injuryHistory);
}

if (weekAwards) {
  const awardsHistory = loadJson(AWARDS_PATH);
  if (!awardsHistory[season]) awardsHistory[season] = [];
  const existing = awardsHistory[season].findIndex((w) => w.weekEnd === weekAwards.weekEnd);
  if (existing >= 0) awardsHistory[season][existing] = weekAwards; // a re-run replaces it
  else awardsHistory[season].push(weekAwards);
  awardsHistory[season].sort((a, b) => a.weekEnd.localeCompare(b.weekEnd));
  saveJson(AWARDS_PATH, awardsHistory);
  console.log(`Weekly awards for the week ending ${weekAwards.weekEnd}: ${Object.keys(weekAwards.awards).join(", ") || "none"}.`);
}

console.log(
  `Snapshotted ${standings.length} teams and ${Object.keys(playerPoints).length} scoring skaters ` +
  `for season ${season} on ${snapshotDate}.`
);
