// Renders the "Standings Over Time" line chart below the standings
// table, from the daily snapshots captured by
// .github/workflows/snapshot-standings.yml into data/standings-history.json.
// That file itself is fetched once (it only changes once a day) — but the
// chart still polls, to keep today's live placeholder point up to date
// (see fetchLiveEntry).
const HISTORY_URL = "data/standings-history.json";
const PROJECTION_NOTE = "Dashed lines project each team's full-season pace.";
const chartCanvas = document.getElementById("standings-chart");
const chartStatus = document.getElementById("chart-status");
const chartHint = document.getElementById("chart-hint");
const rangeSelect = document.getElementById("chart-range");
const projectionNote = document.getElementById("projection-note");
const chartControls = document.getElementById("chart-controls");

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

// ---- Table <-> chart hover linking --------------------------------------
// Hovering a standings row (standings.js) or a line here highlights that
// team in both places: its line thickens and comes to the front while the
// others fade, and its table row gets a bar in the line's color.
let highlightedTeam = null;

// Appends an alpha channel to a "#rrggbb" color.
function withAlpha(hex, alpha) {
  return hex + Math.round(alpha * 255).toString(16).padStart(2, "0");
}

// Re-styles the chart's datasets for the current highlightedTeam. Also
// called after every chart render, since those reset each dataset's
// colors back to its base values.
function applyLineHighlight() {
  if (!chart) return;
  chart.data.datasets.forEach((ds) => {
    const base = ds.baseColor;
    if (!base) return;
    const isTarget = ds.teamName === highlightedTeam;
    const faded = highlightedTeam && !isTarget;
    ds.borderColor = faded ? withAlpha(base, 0.18) : base;
    ds.backgroundColor = faded ? withAlpha(base, 0.18) : base;
    ds.borderWidth = isTarget ? 4 : faded ? 1.5 : 3;
    // Lower order draws on top in Chart.js.
    ds.order = isTarget ? -1 : 0;
  });
  chart.update("none");
}

function linkTeamHighlight(team) {
  if (team === highlightedTeam) return;
  highlightedTeam = team;
  applyLineHighlight();
  const ds = chart && chart.data.datasets.find((d) => d.teamName === team && !d.isProjection);
  if (typeof setLinkedRow === "function") setLinkedRow(team, ds ? ds.baseColor : null);
}

// Chart side of the link: the line nearest the pointer (within a small
// radius, so empty space clears it) is the one highlighted.
function onChartHover(evt, _elements, target) {
  const nearest = target.getElementsAtEventForMode(evt, "nearest", { intersect: false }, false)[0];
  let team = null;
  if (nearest && Math.hypot(nearest.element.x - evt.x, nearest.element.y - evt.y) < 24) {
    team = target.data.datasets[nearest.datasetIndex].teamName;
  }
  linkTeamHighlight(team);
}
chartCanvas.addEventListener("mouseleave", () => linkTeamHighlight(null));

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
        borderColor: realDatasets[i].baseColor,
        backgroundColor: realDatasets[i].baseColor,
        borderDash: [6, 4],
        pointRadius: [0, 5],
        tension: 0,
        isProjection: true,
        projectionFor: i,
        teamName: team,
        baseColor: realDatasets[i].baseColor,
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
  // ?preview-fx (standings.js): show the preview's made-up totals instead.
  if (typeof previewStandingsOverride !== "undefined" && previewStandingsOverride) {
    return { date: todayDateString(), standings: previewStandingsOverride };
  }
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

// ---- Page-load intro -------------------------------------------------------
// When the page opens, the lines draw in from left to right with each
// team's logo riding the head of its line. Whenever a team's standings
// position moved on a day the logo is passing — up or down — it reacts the
// way the table's logos do (see playMoods in standings.js): a hop and a
// sparkle for moving up, a droop and a tear for moving down. When the
// lines have all arrived, each logo gets a moment of its own: the same
// mood, but for how its position changed over the *whole* range (with a
// "▲2"/"▼1" tag), or just a pop if it ended where it started. They
// arrive last place first, so the leader gets the finish.
//
// Only the first render of a page load plays it, and only when the site
// is being opened from somewhere else (see shouldPlayIntro): moving
// between the site's own pages, changing the range or season, the poll
// and the theme flip all show the chart silently, as before.
const INTRO_MS = 2800;
const INTRO_MOOD_MS = 900;
const OUTRO_MOOD_MS = 1400;
const OUTRO_STAGGER_MS = 110;
let introConsumed = false;
// While playing: { start, span (x-axis days covered), events (per dataset
// index: [{ x, mood }] — the day offsets where that team's rank changed),
// outro (per dataset index: { mood, spots, delay } — the arrival), outroMs }.
let intro = null;

function introElapsed() {
  return performance.now() - intro.start;
}

function introProgress() {
  return Math.min(1, introElapsed() / INTRO_MS);
}

function introDone() {
  return introElapsed() >= INTRO_MS + intro.outroMs;
}

// Whether this page load should play the intro. Skipped when the visitor
// got here from another page of this site (a nav link, the back link on a
// team page...) or by back/forward — they've seen it, and it would replay
// on every click. A fresh visit (typed URL, bookmark, a link from
// elsewhere) has no referrer or a foreign one, and plays it.
function shouldPlayIntro(referrer, navigationType, pageUrl) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
  if (navigationType === "back_forward") return false;
  if (!referrer) return true;
  try {
    const from = new URL(referrer);
    const here = new URL(pageUrl);
    // Same origin isn't enough on GitHub Pages — other project sites share
    // it — so also require the referrer to be under this site's folder.
    const base = here.pathname.slice(0, here.pathname.lastIndexOf("/") + 1);
    return !(from.origin === here.origin && from.pathname.startsWith(base));
  } catch {
    return true;
  }
}

function currentNavigationType() {
  try {
    return performance.getEntriesByType("navigation")[0]?.type || "navigate";
  } catch {
    return "navigate";
  }
}

// Competition ranking (ties share a rank), same as the Standings table.
function ranksForEntry(entry) {
  const scored = entry.standings.filter((s) => typeof s.score === "number");
  return new Map(scored.map((s) => [s.team, 1 + scored.filter((o) => o.score > s.score).length]));
}

function buildIntroEvents(entries, teamNames, dayOffset) {
  const events = teamNames.map(() => []);
  let previous = ranksForEntry(entries[0]);
  for (let k = 1; k < entries.length; k++) {
    const current = ranksForEntry(entries[k]);
    teamNames.forEach((team, i) => {
      const from = previous.get(team);
      const to = current.get(team);
      if (from === undefined || to === undefined || from === to) return;
      events[i].push({ x: dayOffset(entries[k].date), mood: to < from ? "happy" : "sad" });
    });
    previous = current;
  }
  return events;
}

// Each team's arrival moment: how its rank at the end of the range
// compares with its rank at the start. Teams arrive last place first.
function buildIntroOutro(entries, teamNames) {
  const first = ranksForEntry(entries[0]);
  const last = ranksForEntry(entries[entries.length - 1]);
  const worst = Math.max(1, ...last.values());
  return teamNames.map((team) => {
    const from = first.get(team);
    const to = last.get(team);
    const spots = from !== undefined && to !== undefined ? from - to : 0; // + = moved up
    return {
      mood: spots > 0 ? "happy" : spots < 0 ? "sad" : "pop",
      spots,
      delay: (worst - (to === undefined ? worst : to)) * OUTRO_STAGGER_MS,
    };
  });
}

// The arrival effect a team's logo is showing `sinceOutro` ms into the
// outro, or null (not its turn yet, or it's finished).
function introOutroAt(datasetIndex, sinceOutro) {
  const o = intro.outro[datasetIndex];
  if (!o) return null;
  const age = sinceOutro - o.delay;
  if (age < 0 || age >= OUTRO_MOOD_MS) return null;
  return { mood: o.mood, p: age / OUTRO_MOOD_MS, spots: o.spots, arrival: true };
}

// The mood a team's logo is showing when the intro has drawn up to
// `valueX` (in x-axis days), or null. It starts when the head reaches the
// day the rank changed and lasts INTRO_MOOD_MS (the intro runs at a
// constant speed, so distance along the axis is time).
function introMoodAt(datasetIndex, valueX) {
  const events = intro.events[datasetIndex];
  if (!events) return null;
  let latest = null;
  for (const ev of events) if (ev.x <= valueX) latest = ev;
  if (!latest) return null;
  const age = ((valueX - latest.x) / intro.span) * INTRO_MS;
  return age < INTRO_MOOD_MS ? { mood: latest.mood, p: age / INTRO_MOOD_MS } : null;
}

// One team's logo (or a plain dot, for a team without one) at the head of
// its line, with its mood applied. Same sizes as the end-of-line logos it
// hands over to when the intro finishes.
function drawIntroHead(ctx, ds, x, y, fx) {
  const logo = Array.isArray(ds.pointStyle) ? ds.pointStyle[ds.pointStyle.length - 1] : null;
  ctx.save();
  ctx.translate(x, y);
  if (fx && fx.mood === "happy") {
    const hop = Math.abs(Math.sin(fx.p * Math.PI * 2));
    ctx.translate(0, -7 * hop);
    ctx.rotate(Math.sin(fx.p * Math.PI * 4) * 0.17);
    ctx.scale(1 + 0.12 * hop, 1 + 0.12 * hop);
  } else if (fx && fx.mood === "pop") {
    // Ended where it started: a quick swell and settle.
    const s = 1 + 0.25 * Math.sin(Math.PI * Math.min(1, fx.p * 2));
    ctx.scale(s, s);
  } else if (fx) {
    const env = Math.min(1, fx.p / 0.2, (1 - fx.p) / 0.2);
    ctx.translate(0, 3 * env);
    ctx.rotate(-0.24 * env);
    ctx.scale(1 - 0.12 * env, 1 - 0.12 * env);
    ctx.filter = `grayscale(${0.8 * env}) brightness(${1 - 0.2 * env})`;
  }
  if (logo && typeof logo === "object") {
    ctx.drawImage(logo, -LOGO_SIZE / 2, -LOGO_SIZE / 2, LOGO_SIZE, LOGO_SIZE);
  } else {
    ctx.fillStyle = ds.baseColor;
    ctx.beginPath();
    ctx.arc(0, 0, 5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  if (!fx) return;
  ctx.save();
  ctx.font = "13px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  if (fx.mood === "happy") {
    ctx.globalAlpha = Math.sin(Math.PI * fx.p);
    ctx.fillText("✨", x + 11, y - 15 - 6 * fx.p);
    if (fx.arrival) {
      // The arrival gets a second sparkle, a beat behind the first.
      const q = Math.min(1, Math.max(0, (fx.p - 0.2) / 0.8));
      ctx.globalAlpha = Math.sin(Math.PI * q);
      ctx.fillText("✨", x - 10, y - 12 - 8 * q);
    }
  } else if (fx.mood === "sad") {
    ctx.globalAlpha = Math.sin(Math.PI * Math.min(1, Math.max(0, (fx.p - 0.15) / 0.85)));
    ctx.fillText("💧", x - 9, y + 4 + 14 * fx.p);
  }

  // How far it moved over the whole range, to the left of the logo (the
  // right edge of the chart has no room), fading in and out with the effect.
  if (fx.arrival && fx.spots) {
    const up = fx.spots > 0;
    ctx.globalAlpha = Math.min(1, fx.p / 0.15, (1 - fx.p) / 0.25);
    ctx.font = "700 12px sans-serif";
    ctx.textAlign = "right";
    const text = `${up ? "▲" : "▼"}${Math.abs(fx.spots)}`;
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.55)";
    ctx.strokeText(text, x - 19, y);
    ctx.fillStyle = up ? "#2fb56a" : "#e5534b";
    ctx.fillText(text, x - 19, y);
  }
  ctx.restore();
}

// Reveals the datasets left to right behind a moving clip edge, then draws
// the heads on top. The clip stops just short of the right edge until the
// very end, so the final point's own logo doesn't peek out under its head.
const introPlugin = {
  id: "intro",
  beforeDatasetsDraw(c) {
    if (!intro) return;
    const t = introProgress();
    const edge = c.scales.x.getPixelForValue(t * intro.span);
    const clipRight = introDone() ? c.width : Math.min(edge, c.chartArea.right - LOGO_SIZE / 2 - 1);
    c.ctx.save();
    c.ctx.beginPath();
    c.ctx.rect(0, 0, Math.max(0, clipRight), c.height);
    c.ctx.clip();
    intro.clipped = true;
  },
  afterDatasetsDraw(c) {
    if (!intro || !intro.clipped) return;
    intro.clipped = false;
    c.ctx.restore();
    if (introDone()) return; // the real end-of-line logos take over
    const t = introProgress();
    const valueX = t * intro.span;
    const edge = c.scales.x.getPixelForValue(valueX);
    const sinceOutro = introElapsed() - INTRO_MS;
    c.data.datasets.forEach((ds, i) => {
      if (ds.isProjection || !c.isDatasetVisible(i)) return;
      if (t >= 1) {
        // Arrived: the head sits on the line's last point.
        const last = c.getDatasetMeta(i).data[ds.data.length - 1];
        if (!last || !Number.isFinite(last.y)) return;
        drawIntroHead(c.ctx, ds, last.x, last.y, introOutroAt(i, sinceOutro));
        return;
      }
      const found = c.getDatasetMeta(i).dataset.interpolate({ x: edge }, "x");
      const p = Array.isArray(found) ? found[0] : found;
      if (!p || !Number.isFinite(p.y)) return;
      drawIntroHead(c.ctx, ds, p.x, p.y, introMoodAt(i, valueX));
    });
  },
};

// Chart.js has nothing to animate here (its own creation animation is
// switched off), so the intro just asks it to repaint every frame.
function runIntro(c) {
  const mine = intro;
  const tick = () => {
    if (intro !== mine || chart !== c) return; // superseded by a newer render
    const done = introDone();
    if (done) intro = null;
    c.draw();
    if (!done) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// The trade deadline, marked as a dashed amber line with a small label at
// the top, in whichever range being shown it falls inside — the Projected
// range always reaches it, the Season range once it has passed, and a
// shorter range if it happens to be in that window. Out of range, nothing. Its position and text come from the
// chart's `options.plugins.tradeDeadline` ({ x, label }, x null = none),
// set on every render in renderChart.
const DEADLINE_COLOR = "#ffb020";
const tradeDeadlinePlugin = {
  id: "tradeDeadline",
  afterDatasetsDraw(c, _args, opts) {
    if (!opts || opts.x == null) return;
    const { left, right, top, bottom } = c.chartArea;
    const x = Math.round(c.scales.x.getPixelForValue(opts.x)) + 0.5;
    if (x < left || x > right) return; // outside the range being shown
    const ctx = c.ctx;
    ctx.save();
    ctx.strokeStyle = DEADLINE_COLOR;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
    ctx.setLineDash([]);
    // The label sits on whichever side of the line has room.
    ctx.font = "600 11px sans-serif";
    ctx.fillStyle = DEADLINE_COLOR;
    ctx.textBaseline = "top";
    const flip = x + 8 + ctx.measureText(opts.label).width > right;
    ctx.textAlign = flip ? "right" : "left";
    ctx.fillText(opts.label, flip ? x - 6 : x + 6, top + 4);
    ctx.restore();
  },
};

// The 1 Week and 1 Month ranges are short windows, so starting the axis at
// 0 would squash every line into the top of the chart — leave the bottom
// to Chart.js there, which fits it to the lowest *shown* point in the
// window (so it also tightens up when comparing a subset of teams, and
// rises as old days slide out of the window). Season and Projected keep
// the axis anchored at 0 so the season's overall growth reads honestly.
function yAxisMin(range) {
  return range === "week" || range === "month" ? undefined : 0;
}

async function renderChart(season) {
  const myToken = ++renderToken;
  // Only the very first render of a page load can get the intro, and only
  // when the site is being opened fresh (see shouldPlayIntro).
  const playIntro = !introConsumed && shouldPlayIntro(document.referrer, currentNavigationType(), location.href);
  introConsumed = true;

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
    // A team no longer in the season's list (e.g. dropped from teams.js
    // after it appears in older snapshots) falls back to a position-based color.
    const color = getTeamColor(season, team) || TEAM_COLORS[i % TEAM_COLORS.length];
    const dataset = {
      label: team,
      data: entries.map((e) => {
        const found = e.standings.find((s) => s.team === team);
        return { x: dayOffset(e.date), y: found ? found.score : null };
      }),
      borderColor: color,
      backgroundColor: color,
      spanGaps: true,
      tension: 0.2,
      teamName: team,
      baseColor: color,
    };

    // Just the lines, with no dot on every day (it clutters them) — only the
    // end of each is marked: its logo, or a dot for a team without one.
    // Hovering still picks out the nearest day: the dot appears and the
    // tooltip shows, which is what the wider hit radius is for.
    const lastIndex = dataset.data.length - 1;
    dataset.pointRadius = dataset.data.map((_, idx) => (idx === lastIndex ? 3 : 0));
    dataset.pointHitRadius = 8;

    const logoSrc = getTeamLogo(season, team);
    const logo = logoSrc ? await loadLogo(logoSrc) : null;
    if (logo) {
      dataset.pointStyle = dataset.data.map((_, idx) => (idx === lastIndex ? logo : "circle"));
      dataset.pointRadius = dataset.data.map((_, idx) => (idx === lastIndex ? LAST_POINT_RADIUS : 0));
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

  // The trade deadline's line (the plugin skips it when it's outside the
  // range). The note under the chart only comes with the Projected range.
  // (getTradeDeadline / formatDeadlineParts come from teams.js / deadline.js —
  // checked in case a browser pairs a cached older copy of one with this file.)
  const canMarkDeadline = typeof getTradeDeadline === "function" && typeof formatDeadlineParts === "function";
  const deadline = canMarkDeadline ? getTradeDeadline(season) : null;
  const deadlineParts = deadline ? formatDeadlineParts(deadline) : null;
  const deadlineOpts = deadline
    ? { x: dayOffset(easternDate(deadline)), label: `Trade deadline · ${deadlineParts.day.split(", ")[1]}` }
    : { x: null };
  projectionNote.textContent = deadline && rangeSelect.value === "projected"
    ? `${PROJECTION_NOTE} The amber line marks the trade deadline (${deadlineParts.day} at ${deadlineParts.time}).`
    : PROJECTION_NOTE;

  const chromeColors = chartChromeColors();

  if (chart) {
    intro = null; // a render landing mid-intro just shows the chart as it is
    // Update the existing instance instead of destroy+recreate — a brand
    // new Chart animates every point growing up from the axis baseline,
    // which on every poll made the whole line flash down to 0 and back.
    // Chart.js also keys each point's prior animated position off the
    // dataset *object identity* at that index, so handing it a fresh
    // object (even with identical values) still triggers that same
    // from-baseline animation — mutating the existing objects in place
    // (matched by label) keeps the identity so it animates from each
    // point's actual previous position instead.
    const existingByLabel = new Map(chart.data.datasets.map((d) => [d.label, d]));
    chart.data.datasets = datasets.map((desired) => {
      const existing = existingByLabel.get(desired.label);
      if (!existing) return desired;
      Object.assign(existing, desired);
      return existing;
    });
    // A projection line created by this render (the range just switched to
    // Projected) starts out visible — make it follow its team instead, so a
    // comparison in progress (see the legend's onClick) isn't undone.
    chart.data.datasets.forEach((ds, i) => {
      if (ds.projectionFor !== undefined) chart.setDatasetVisibility(i, chart.isDatasetVisible(ds.projectionFor));
    });
    chart.options.plugins.tradeDeadline = deadlineOpts;
    chart.options.plugins.tooltip.callbacks.title = (items) =>
      items.length ? formatDayOffset(baseTime, items[0].parsed.x) : "";
    chart.options.plugins.legend.labels.color = chromeColors.text;
    chart.options.scales.x.ticks.color = chromeColors.muted;
    chart.options.scales.x.ticks.callback = (value) => formatDayOffset(baseTime, value);
    chart.options.scales.x.grid.color = chromeColors.border;
    chart.options.scales.y.min = yAxisMin(rangeSelect.value);
    chart.options.scales.y.ticks.color = chromeColors.muted;
    chart.options.scales.y.grid.color = chromeColors.border;
    chart.update();
    if (highlightedTeam) applyLineHighlight();
    return;
  }

  // Set before the chart exists so even its first paint is clipped to
  // nothing — the axes show, then the lines sweep in (see introPlugin).
  const outro = playIntro ? buildIntroOutro(entries, teamNames) : [];
  intro = playIntro
    ? {
        start: performance.now(),
        span: dayOffset(entries[entries.length - 1].date),
        events: buildIntroEvents(entries, teamNames, dayOffset),
        outro,
        outroMs: Math.max(0, ...outro.map((o) => o.delay)) + OUTRO_MOOD_MS,
      }
    : null;

  chart = new Chart(chartCanvas, {
    type: "line",
    data: { datasets },
    plugins: [introPlugin, tradeDeadlinePlugin],
    options: {
      // Chart.js's own creation animation grows every point up from the
      // axis — off here (the intro replaces it, and a chart re-created
      // later, e.g. after a too-short range, shouldn't replay anything).
      // Switched back on right after construction (below) so later
      // in-place updates still glide.
      animation: false,
      responsive: true,
      // Without this, Chart.js holds a fixed 2:1 aspect ratio — on a
      // narrow (mobile) width that caps the canvas well short of the
      // container's actual height, leaving dead space below the chart.
      maintainAspectRatio: false,
      onHover: onChartHover,
      plugins: {
        tradeDeadline: deadlineOpts,
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
            // Legend follows dataset draw `order` by default, which the
            // hover highlight changes (to bring a line to the front) —
            // this keeps the legend itself from reshuffling on hover.
            sort: (a, b) => a.datasetIndex - b.datasetIndex,
          },
          // Default Chart.js behavior just toggles one line at a time.
          // This is built for comparing teams instead: with everyone
          // shown, a click isolates that team; after that, clicking
          // another team adds it, clicking a shown team removes it, and
          // removing the last one (clicking the only team shown) brings
          // everyone back. A team's dashed projection, if any, follows it.
          // No modifier keys, so it works the same by tap on a phone.
          onClick: (evt, legendItem, legend) => {
            const target = legend.chart;
            const groupOf = (i) => {
              const ds = target.data.datasets[i];
              return ds.projectionFor !== undefined ? ds.projectionFor : i;
            };
            // A group's id is its real dataset's index, so that's the one
            // to ask about visibility.
            const groups = [...new Set(target.data.datasets.map((_, i) => groupOf(i)))];
            const shown = new Set(groups.filter((g) => target.isDatasetVisible(g)));
            const clicked = groupOf(legendItem.datasetIndex);

            let next;
            if (shown.size === groups.length) next = new Set([clicked]); // everyone shown -> isolate
            else if (!shown.has(clicked)) next = new Set([...shown, clicked]); // add to the comparison
            else if (shown.size === 1) next = new Set(groups); // the last one -> everyone
            else next = new Set([...shown].filter((g) => g !== clicked)); // remove from the comparison

            target.data.datasets.forEach((_, i) => target.setDatasetVisibility(i, next.has(groupOf(i))));
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
        y: {
          min: yAxisMin(rangeSelect.value),
          // A little headroom under the lowest line when the bottom is
          // auto-fitted — but scores can't be negative, so never below 0
          // (the grace would otherwise carry a line sitting at 0 under it,
          // and the nice-number tick rounding can reach lower still).
          grace: "5%",
          afterBuildTicks: (scale) => {
            if (scale.min >= 0) return;
            scale.ticks = scale.ticks.filter((t) => t.value >= 0);
            scale.min = 0;
          },
          ticks: { color: chromeColors.muted, precision: 0 },
          grid: { color: chromeColors.border },
        },
      },
    },
  });

  // Back to Chart.js's default animation settings for everything after
  // this first paint (range changes, polls and legend clicks glide).
  chart.options.animation = {};
  if (intro) {
    intro.start = performance.now();
    runIntro(chart);
  }
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
