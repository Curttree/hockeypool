// Renders the "Standings Over Time" line chart below the standings
// table, from the daily snapshots captured by
// .github/workflows/snapshot-standings.yml into data/standings-history.json.
// That file itself is fetched once (it only changes once a day) — but the
// chart still polls, to keep today's live placeholder point up to date
// (see fetchLiveEntry).
const HISTORY_URL = "data/standings-history.json";
const chartCanvas = document.getElementById("standings-chart");
const chartStatus = document.getElementById("chart-status");
const chartHint = document.getElementById("chart-hint");
const rangeSelect = document.getElementById("chart-range");
const projectionNote = document.getElementById("projection-note");
const chartControls = document.getElementById("chart-controls");

const TEAM_COLORS = [
  "#4ea1ff", "#ff8a4e", "#5ee6a0", "#e659c9", "#f4d35e", "#9d8cff", "#ff5c5c", "#5ec8e6",
];

// Days to look back from the most recent snapshot for each range option
// (null = no limit, show the whole season — "projected" is the same
// full-season view as "season", just with the trend line added too).
// Anchored to the latest snapshot's own date rather than today's real
// date, so the window doesn't look short just because today's snapshot
// hasn't run yet.
const RANGE_DAYS = { week: 7, month: 30, season: null, projected: null };

let historyData = null;
let chart = null;
let renderToken = 0;

const LAST_POINT_RADIUS = 14;
// Chart.js draws Image pointStyles at the image's own width/height and
// ignores pointRadius entirely, so an SVG with no intrinsic size (ours
// default to the browser's 300x150 fallback) renders huge. Forcing the
// Image element's width/height right after load fixes the drawn size.
const LOGO_SIZE = LAST_POINT_RADIUS * 2;

// Loaded once per image path and reused — Chart.js's pointStyle needs an
// already-loaded HTMLImageElement, not just a URL.
const logoCache = new Map();
function loadLogo(src) {
  if (!logoCache.has(src)) {
    logoCache.set(src, new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        img.width = LOGO_SIZE;
        img.height = LOGO_SIZE;
        resolve(img);
      };
      img.onerror = () => resolve(null); // missing/broken file -> fall back to a plain dot
      img.src = src;
    }));
  }
  return logoCache.get(src);
}

// A pace shift from a month ago should count for less than one from
// yesterday — each point's weight halves every this many days further
// back from the most recent point being fit.
const PROJECTION_HALF_LIFE_DAYS = 7;

// Weighted least-squares fit of y = m*x + b through the given
// { x, y, w } points. Returns null if there aren't at least 2 points,
// or they're all at the same x (a vertical fit isn't meaningful here).
function weightedLinearRegression(points) {
  if (points.length < 2) return null;
  let sumW = 0, sumWX = 0, sumWY = 0, sumWXY = 0, sumWXX = 0;
  points.forEach(({ x, y, w }) => {
    sumW += w;
    sumWX += w * x;
    sumWY += w * y;
    sumWXY += w * x * y;
    sumWXX += w * x * x;
  });
  const denom = sumW * sumWXX - sumWX * sumWX;
  if (denom === 0) return null;
  const m = (sumW * sumWXY - sumWX * sumWY) / denom;
  const b = (sumWY - m * sumWX) / sumW;
  return { m, b };
}

const DAY_MS = 24 * 60 * 60 * 1000;

// The x-axis is a plain linear scale of "days since the first point"
// (not Chart.js's category scale, which would space every point evenly
// regardless of the actual gap between dates) — this turns a numeric
// offset back into the calendar date it represents, for ticks/tooltips.
function formatDayOffset(baseTime, offset) {
  return new Date(baseTime + offset * DAY_MS).toISOString().slice(0, 10);
}

// Builds one dashed "projection" dataset per team: a linear trend fit
// through that team's already-captured points (over whatever range is
// currently selected) — weighted so recent snapshots count more than
// older ones — extrapolated to the season's end date. Returns [] if
// the season's already effectively over, or there's nothing worth
// projecting from.
function buildProjectionDatasets(season, entries, teamNames, realDatasets) {
  const seasonEnd = getSeasonEnd(season);
  const seasonEndTime = new Date(seasonEnd).getTime();
  const baseTime = new Date(entries[0].date).getTime();
  const lastTime = new Date(entries[entries.length - 1].date).getTime();
  if (!(seasonEndTime > lastTime)) return [];

  const endX = (seasonEndTime - baseTime) / DAY_MS;
  const lastX = (lastTime - baseTime) / DAY_MS;

  return teamNames
    .map((team, i) => {
      const lastPoint = realDatasets[i].data[realDatasets[i].data.length - 1];
      if (lastPoint.y == null) return null; // team has no value at the last displayed point

      const points = entries
        .map((e) => {
          const found = e.standings.find((s) => s.team === team);
          if (!found) return null;
          const x = (new Date(e.date).getTime() - baseTime) / DAY_MS;
          const w = Math.pow(0.5, (lastX - x) / PROJECTION_HALF_LIFE_DAYS);
          return { x, y: found.score, w };
        })
        .filter(Boolean);
      const fit = weightedLinearRegression(points);
      if (!fit) return null;

      const projected = Math.max(0, Math.round(fit.m * endX + fit.b));

      return {
        label: `${team} (Projected)`,
        // Just the two endpoints — anchored to the real line's last
        // point, out to the projected value at the season's end date.
        data: [
          { x: lastPoint.x, y: lastPoint.y },
          { x: endX, y: projected },
        ],
        borderColor: TEAM_COLORS[i % TEAM_COLORS.length],
        backgroundColor: TEAM_COLORS[i % TEAM_COLORS.length],
        borderDash: [6, 4],
        pointRadius: [0, 5],
        tension: 0,
        isProjection: true,
        projectionFor: i,
      };
    })
    .filter(Boolean);
}

// Chart.js colors are set via JS options, not CSS, so they don't follow
// the light/dark toggle on their own — reading the current theme's CSS
// variables here (rather than duplicating hex values) keeps this in sync
// with style.css automatically, whichever theme is active.
function chartChromeColors() {
  const styles = getComputedStyle(document.documentElement);
  return {
    text: styles.getPropertyValue("--text").trim(),
    muted: styles.getPropertyValue("--muted").trim(),
    border: styles.getPropertyValue("--border").trim(),
  };
}

function todayDateString() {
  return new Date().toISOString().slice(0, 10);
}

// The nightly Action always tags a snapshot with the *previous* day (it
// runs early morning, reporting on last night's games — see
// snapshot-standings.mjs), so there's never a persisted entry for today
// until tomorrow. This fills that gap with a live-computed one — reusing
// the exact same scoring logic the Standings table itself uses — so
// today's in-progress totals show up right away instead of only once the
// nightly Action gets around to them. It's provisional: recomputed on
// every render (poll or otherwise) and simply never written to disk, so
// once a real persisted entry for today exists (the Action having since
// run), that one wins and this stops getting called for that date.
async function fetchLiveEntry(season) {
  const [roster, previousRoster] = await Promise.all([
    fetchAllPlayersForSeason(season),
    fetchAllPlayersForSeason(previousSeasonId(season)).catch(() => []),
  ]);
  const standings = computeStandings(season, getTeamsForSeason(season), roster, previousRoster);
  return {
    date: todayDateString(),
    standings: standings.map((t) => ({ team: t.name, score: t.score })),
  };
}

function filterByRange(entries, range) {
  const days = RANGE_DAYS[range];
  if (!days || entries.length === 0) return entries;

  const cutoff = new Date(entries[entries.length - 1].date);
  cutoff.setDate(cutoff.getDate() - (days - 1));
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  return entries.filter((e) => e.date >= cutoffStr);
}

async function renderChart(season) {
  const myToken = ++renderToken;

  // The range picker (including "Projected") only makes sense for the
  // season currently being played — hide it for past seasons and
  // always show their full history instead.
  const seasons = getPoolSeasons();
  const isCurrentSeason = season === seasons[seasons.length - 1];
  chartControls.hidden = !isCurrentSeason;
  if (!isCurrentSeason) rangeSelect.value = "season";

  const allEntries = (historyData[season] || []).slice().sort((a, b) => a.date.localeCompare(b.date));

  // No persisted entry for today yet (see fetchLiveEntry) — add a live
  // one computed the same way the Standings table is, so today's
  // in-progress totals show up without waiting for tonight's snapshot.
  if (isCurrentSeason && !allEntries.some((e) => e.date === todayDateString())) {
    const liveEntry = await fetchLiveEntry(season).catch(() => null);
    if (myToken !== renderToken) return; // a newer render call already took over
    if (liveEntry) {
      allEntries.push(liveEntry);
      allEntries.sort((a, b) => a.date.localeCompare(b.date));
    }
  }

  const entries = filterByRange(allEntries, rangeSelect.value);

  if (entries.length < 2) {
    chartCanvas.hidden = true;
    chartHint.hidden = true;
    projectionNote.hidden = true;
    chartStatus.hidden = false;
    chartStatus.classList.remove("loading-pulse");
    if (allEntries.length === 0) {
      chartStatus.textContent = "No history yet for this season — check back after the first daily snapshot.";
    } else if (allEntries.length === 1) {
      chartStatus.textContent = "Only one day of history so far — check back tomorrow for a trend line.";
    } else {
      chartStatus.textContent = "Not enough history in this range yet — try a wider range.";
    }
    if (chart) {
      chart.destroy();
      chart = null;
    }
    return;
  }

  // "Days since the first displayed point" — the numeric x-scale value
  // powering real, proportional time spacing (see formatDayOffset).
  const baseTime = new Date(entries[0].date).getTime();
  const dayOffset = (dateStr) => (new Date(dateStr).getTime() - baseTime) / DAY_MS;

  const teamNames = [...new Set(entries.flatMap((e) => e.standings.map((s) => s.team)))];

  const datasets = await Promise.all(teamNames.map(async (team, i) => {
    const dataset = {
      label: team,
      data: entries.map((e) => {
        const found = e.standings.find((s) => s.team === team);
        return { x: dayOffset(e.date), y: found ? found.score : null };
      }),
      borderColor: TEAM_COLORS[i % TEAM_COLORS.length],
      backgroundColor: TEAM_COLORS[i % TEAM_COLORS.length],
      spanGaps: true,
      tension: 0.2,
    };

    const logoSrc = getTeamLogo(season, team);
    const logo = logoSrc ? await loadLogo(logoSrc) : null;
    if (logo) {
      const lastIndex = dataset.data.length - 1;
      dataset.pointStyle = dataset.data.map((_, idx) => (idx === lastIndex ? logo : "circle"));
      dataset.pointRadius = dataset.data.map((_, idx) => (idx === lastIndex ? LAST_POINT_RADIUS : 3));
    }

    return dataset;
  }));

  // Season/range changed again while logos were loading — a newer call
  // to renderChart already took over, so drop this now-stale result.
  if (myToken !== renderToken) return;

  let addedProjection = false;
  if (isCurrentSeason && rangeSelect.value === "projected") {
    const projectionDatasets = buildProjectionDatasets(season, entries, teamNames, datasets);
    if (projectionDatasets.length) {
      addedProjection = true;
      datasets.push(...projectionDatasets);
    }
  }

  chartStatus.hidden = true;
  chartCanvas.hidden = false;
  chartHint.hidden = false;
  projectionNote.hidden = !addedProjection;

  const chromeColors = chartChromeColors();

  if (chart) chart.destroy();
  chart = new Chart(chartCanvas, {
    type: "line",
    data: { datasets },
    options: {
      responsive: true,
      // Without this, Chart.js holds a fixed 2:1 aspect ratio — on a
      // narrow (mobile) width that caps the canvas well short of the
      // container's actual height, leaving dead space below the chart.
      maintainAspectRatio: false,
      plugins: {
        tooltip: {
          callbacks: {
            title: (items) => (items.length ? formatDayOffset(baseTime, items[0].parsed.x) : ""),
          },
        },
        legend: {
          labels: {
            color: chromeColors.text,
            // Projection datasets ride along with their team's real
            // dataset (see onClick below) — they don't need their own
            // legend entry too.
            filter: (legendItem, data) => !data.datasets[legendItem.datasetIndex].isProjection,
          },
          // Default Chart.js behavior just toggles one line at a time.
          // This instead isolates: click a team to hide every other
          // line (and that team's own dashed projection, if any), click
          // it again (or click the last remaining solo line) to restore
          // all of them.
          onClick: (evt, legendItem, legend) => {
            const target = legend.chart;
            const index = legendItem.datasetIndex;
            const groupOf = (i) => {
              const ds = target.data.datasets[i];
              return ds.projectionFor !== undefined ? ds.projectionFor : i;
            };
            const clickedGroup = groupOf(index);
            const onlyThisGroupVisible = target.data.datasets.every((_, i) =>
              (groupOf(i) === clickedGroup) === target.isDatasetVisible(i)
            );

            target.data.datasets.forEach((_, i) => {
              target.setDatasetVisibility(i, onlyThisGroupVisible || groupOf(i) === clickedGroup);
            });
            target.update();
          },
        },
      },
      scales: {
        // A linear (not category) scale so the gap between two points
        // reflects the actual number of days between them, rather than
        // every point being spaced evenly regardless of date.
        x: {
          type: "linear",
          // precision: 0 keeps auto-picked tick steps whole numbers of
          // days — otherwise a fractional step (e.g. every half day, on a
          // short-enough range) rounds through formatDayOffset to the
          // same calendar date twice in a row.
          ticks: { color: chromeColors.muted, precision: 0, callback: (value) => formatDayOffset(baseTime, value) },
          grid: { color: chromeColors.border },
        },
        // precision: 0 keeps auto-picked tick steps whole numbers — points
        // are always integers, so a fractional step (e.g. while every
        // score is still 0 before the season starts) just looks odd.
        y: { min: 0, ticks: { color: chromeColors.muted, precision: 0 }, grid: { color: chromeColors.border } },
      },
    },
  });
}

async function initHistory() {
  try {
    historyData = await fetch(HISTORY_URL).then((r) => r.json());
  } catch {
    historyData = {};
  }

  renderChart(seasonSelect.value);
  seasonSelect.addEventListener("change", () => renderChart(seasonSelect.value));
  rangeSelect.addEventListener("change", () => renderChart(seasonSelect.value));
  // Chart.js colors are baked into the chart at construction time, so a
  // theme flip needs an explicit re-render to pick up the new palette.
  window.addEventListener("themechange", () => renderChart(seasonSelect.value));

  // Keeps today's live placeholder point (see fetchLiveEntry) moving as
  // new results come in — POLL_INTERVAL_MS is standings.js's, already
  // declared in this same shared (non-module) script scope.
  setInterval(() => {
    if (document.visibilityState === "visible") renderChart(seasonSelect.value);
  }, POLL_INTERVAL_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") renderChart(seasonSelect.value);
  });
}

initHistory();
