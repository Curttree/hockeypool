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

    return { season, standings };
  } finally {
    await browser.close();
  }
}

function loadHistory() {
  if (!existsSync(DATA_PATH)) return {};
  return JSON.parse(readFileSync(DATA_PATH, "utf8"));
}

function saveHistory(history) {
  mkdirSync(dirname(DATA_PATH), { recursive: true });
  writeFileSync(DATA_PATH, JSON.stringify(history, null, 2) + "\n");
}

const { season, standings } = await captureSnapshot();
if (!standings.length) {
  throw new Error("Scraped zero teams from the standings table — page likely didn't render as expected.");
}

const history = loadHistory();
if (!history[season]) history[season] = [];

const today = new Date().toISOString().slice(0, 10);
const entry = { date: today, standings };
const existingIndex = history[season].findIndex((e) => e.date === today);
if (existingIndex >= 0) {
  history[season][existingIndex] = entry; // re-running the same day (e.g. manual dispatch) overwrites, doesn't duplicate
} else {
  history[season].push(entry);
}

saveHistory(history);
console.log(`Snapshotted ${standings.length} teams for season ${season} on ${today}.`);
