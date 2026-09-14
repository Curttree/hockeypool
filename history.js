// Renders the "Standings Over Time" line chart below the standings
// table, from the daily snapshots captured by
// .github/workflows/snapshot-standings.yml into data/standings-history.json.
// That file is static — no polling needed, it only changes once a day.
const HISTORY_URL = "data/standings-history.json";
const chartCanvas = document.getElementById("standings-chart");
const chartStatus = document.getElementById("chart-status");
const chartHint = document.getElementById("chart-hint");
const rangeSelect = document.getElementById("chart-range");

const TEAM_COLORS = [
  "#4ea1ff", "#ff8a4e", "#5ee6a0", "#e659c9", "#f4d35e", "#9d8cff", "#ff5c5c", "#5ec8e6",
];

// Days to look back from the most recent snapshot for each range option
// (null = no limit, show the whole season). Anchored to the latest
// snapshot's own date rather than today's real date, so the window
// doesn't look short just because today's snapshot hasn't run yet.
const RANGE_DAYS = { week: 7, month: 30, season: null };

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
  const allEntries = (historyData[season] || []).slice().sort((a, b) => a.date.localeCompare(b.date));
  const entries = filterByRange(allEntries, rangeSelect.value);

  if (entries.length < 2) {
    chartCanvas.hidden = true;
    chartHint.hidden = true;
    chartStatus.hidden = false;
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

  const labels = entries.map((e) => e.date);
  const teamNames = [...new Set(entries.flatMap((e) => e.standings.map((s) => s.team)))];

  const datasets = await Promise.all(teamNames.map(async (team, i) => {
    const dataset = {
      label: team,
      data: entries.map((e) => {
        const found = e.standings.find((s) => s.team === team);
        return found ? found.score : null;
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

  chartStatus.hidden = true;
  chartCanvas.hidden = false;
  chartHint.hidden = false;

  if (chart) chart.destroy();
  chart = new Chart(chartCanvas, {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      plugins: {
        legend: {
          labels: { color: "#e8eaed" },
          // Default Chart.js behavior just toggles one line at a time.
          // This instead isolates: click a team to hide every other
          // line, click it again (or click the last remaining solo line)
          // to restore all of them.
          onClick: (evt, legendItem, legend) => {
            const target = legend.chart;
            const index = legendItem.datasetIndex;
            const onlyThisOneVisible = target.data.datasets.every((_, i) =>
              i === index ? target.isDatasetVisible(i) : !target.isDatasetVisible(i)
            );

            target.data.datasets.forEach((_, i) => {
              target.setDatasetVisibility(i, onlyThisOneVisible || i === index);
            });
            target.update();
          },
        },
      },
      scales: {
        x: { ticks: { color: "#9aa2af" }, grid: { color: "#2a2f3a" } },
        y: { ticks: { color: "#9aa2af" }, grid: { color: "#2a2f3a" } },
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
}

initHistory();
