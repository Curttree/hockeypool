// "Last night" recap banner above the standings: each team's points from
// the most recent night of games, plus anyone who moved up or down the
// standings. Normally built from the two most recent daily snapshots in
// data/standings-history.json (written overnight by the snapshot Action) —
// but that Action can start hours late or skip a night, so when the
// snapshots don't cover last night (or span more than one night), it's
// built from the live data instead (see buildLiveRecap).
//
// Stays up until closed, and closing it is remembered per snapshot date
// (per browser), so each new night's recap shows up once more. Hidden when
// nobody scored (off nights, preseason) and for past seasons.
const RECAP_HISTORY_URL = "data/standings-history.json";
const RECAP_DISMISSED_KEY = "hockeypool-recap-dismissed";
const recapEl = document.getElementById("recap");

function recapDismissedDate() {
  try {
    return localStorage.getItem(RECAP_DISMISSED_KEY);
  } catch {
    return null;
  }
}

function dismissRecap(date) {
  try {
    localStorage.setItem(RECAP_DISMISSED_KEY, date);
  } catch {
    // ignore (storage disabled) — it just reappears next visit
  }
}

// Team -> rank, standard competition ranking (ties share a rank), same as
// the standings table.
function snapshotRanks(entry) {
  const sorted = entry.standings.slice().sort((a, b) => b.score - a.score);
  const ranks = new Map();
  sorted.forEach((s, i) => {
    ranks.set(s.team, i > 0 && s.score === sorted[i - 1].score ? ranks.get(sorted[i - 1].team) : i + 1);
  });
  return ranks;
}

function ordinal(n) {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : { 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th";
  return `${n}${suffix}`;
}

// Snapshots are tagged with the date the games were played, so the latest
// one is usually yesterday — "Last night". If it's older (e.g. a few days
// off), name the date instead. A recap that spans more than one night (a
// daily snapshot was missed) says where it starts rather than claim to be
// "last night".
function recapHeading(recap) {
  const label = (date) => new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  if (recap.since) return `Since ${label(recap.since)}`;
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (recap.date === yesterday.toLocaleDateString("en-CA")) return "Last night";
  return `On ${label(recap.date)}`;
}

// { date, items: [{ team, gain, from, to }] } for the change from one
// standings snapshot ({ date, standings: [{ team, score }] }) to the next,
// biggest gain first — or null if nobody scored. `since` is set when the two
// aren't consecutive days, so the recap spans more than one night.
function recapBetween(previous, latest) {
  const prevScores = new Map(previous.standings.map((s) => [s.team, s.score]));
  const prevRanks = snapshotRanks(previous);
  const latestRanks = snapshotRanks(latest);
  const items = latest.standings
    .filter((s) => prevScores.has(s.team))
    .map((s) => ({
      team: s.team,
      gain: s.score - prevScores.get(s.team),
      from: prevRanks.get(s.team),
      to: latestRanks.get(s.team),
    }))
    .sort((a, b) => b.gain - a.gain || a.to - b.to);
  if (!items.some((item) => item.gain > 0)) return null;
  const recap = { date: latest.date, items };
  if (previous.date !== previousDate(latest.date)) recap.since = previous.date;
  return recap;
}

// The recap from the two most recent snapshots — or null if there aren't
// two yet, or nobody scored between them.
function buildRecap(entries) {
  if (entries.length < 2) return null;
  const [previous, latest] = entries.slice(-2);
  return recapBetween(previous, latest);
}

// The live roster as it stood at the end of `throughDate`: every night after
// it taken back out. (Live players carry their points split by game date —
// see /api/live in worker.js.)
function rosterThrough(roster, throughDate) {
  return roster.map((p) => {
    if (!p.byDate) return p;
    let goals = 0, assists = 0, points = 0;
    Object.entries(p.byDate).forEach(([date, day]) => {
      if (date > throughDate) {
        goals += day.goals;
        assists += day.assists;
        points += day.points;
      }
    });
    return { ...p, goals: p.goals - goals, assists: p.assists - assists, points: p.points - points };
  });
}

// The recap for one night built from the live data, with the same scoring
// the standings table uses: standings at the end of that night versus the
// night before. Null if the live data doesn't have that night (it only
// covers the NHL's current and previous game dates, and only games that
// have started) or nobody scored. Shares the page's roster fetch, so it
// costs no extra requests.
async function buildLiveRecap(season, night) {
  const [roster, previousRoster] = await Promise.all([
    fetchAllPlayersForSeason(season),
    fetchAllPlayersForSeason(previousSeasonId(season)).catch(() => []),
  ]);
  if (!roster.some((p) => p.byDate && p.byDate[night])) return null;

  const teams = getTeamsForSeason(season);
  const standingsAt = (date) => ({
    date,
    standings: computeStandings(season, teams, rosterThrough(roster, date), previousRoster).map((t) => ({ team: t.name, score: t.score })),
  });
  return recapBetween(standingsAt(previousDate(night)), standingsAt(night));
}

function renderRecap(season, recap, { preview = false } = {}) {
  const topGain = recap.items[0].gain;
  const chips = recap.items.map((item, i) => {
    const logoSrc = getTeamLogo(season, item.team);
    const logo = logoSrc ? `<img class="recap-logo" src="${logoSrc}" alt="" width="22" height="22">` : "";
    const move = item.to < item.from
      ? `<span class="recap-move up" title="Up from ${ordinal(item.from)}">▲ ${ordinal(item.to)}</span>`
      : item.to > item.from
        ? `<span class="recap-move down" title="Down from ${ordinal(item.from)}">▼ ${ordinal(item.to)}</span>`
        : "";
    const isTop = item.gain > 0 && item.gain === topGain;
    return `<li class="recap-item${isTop ? " top" : ""}${item.gain === 0 ? " quiet" : ""}" style="--i:${i}">
      ${logo}<span class="recap-team">${item.team}</span>
      <span class="recap-gain">+${item.gain}</span>${move}
    </li>`;
  }).join("");

  recapEl.innerHTML = `
    <div class="recap-head">
      <span class="recap-title">🏒 ${recapHeading(recap)}${preview ? " (preview)" : ""}</span>
      <button type="button" class="recap-close" aria-label="Close recap">×</button>
    </div>
    <ul class="recap-list">${chips}</ul>
  `;
  recapEl.querySelector(".recap-close").addEventListener("click", () => {
    if (!preview) dismissRecap(recap.date);
    recapEl.hidden = true;
  });
  recapEl.hidden = false;
}

// ?preview-fx (standings.js runPreview): recap the preview's made-up
// update, so the banner matches what the table and chart show.
function showPreviewRecap(season, realStandings, fakeStandings) {
  const before = new Map(realStandings.map((t) => [t.name, t]));
  const items = fakeStandings
    .filter((t) => before.has(t.name))
    .map((t) => ({ team: t.name, gain: t.score - before.get(t.name).score, from: before.get(t.name).rank, to: t.rank }))
    .sort((a, b) => b.gain - a.gain || a.to - b.to);
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  renderRecap(season, { date: yesterday.toLocaleDateString("en-CA"), items }, { preview: true });
}

async function showRecap(season) {
  recapEl.hidden = true;
  const seasons = getPoolSeasons();
  if (season !== seasons[seasons.length - 1]) return; // past seasons: nothing new to recap

  // ?preview-fx: standings.js calls showPreviewRecap once its made-up
  // update is ready.
  if (new URLSearchParams(location.search).has("preview-fx")) return;

  try {
    const history = await fetch(RECAP_HISTORY_URL).then((r) => r.json());
    const entries = (history[season] || []).slice().sort((a, b) => a.date.localeCompare(b.date));
    let recap = buildRecap(entries);

    // The snapshot Action can start hours late, or skip a night. If the
    // snapshots don't reach last night yet — or span more than one night
    // because one was missed — use the live data for last night instead,
    // when it has it. (Otherwise the snapshot recap stands, as before: e.g.
    // locally, where there's no live data.)
    const lastNight = previousDate(currentNightDate());
    if (!recap || recap.date < lastNight || recap.since) {
      const live = await buildLiveRecap(season, lastNight).catch(() => null);
      if (live) recap = live;
    }

    if (!recap || recapDismissedDate() === recap.date) return;
    if (seasonSelect.value !== season) return; // season changed while loading
    renderRecap(season, recap);
  } catch {
    // a recap is a nice-to-have — never let it break the page
  }
}

showRecap(seasonSelect.value);
seasonSelect.addEventListener("change", () => showRecap(seasonSelect.value));
