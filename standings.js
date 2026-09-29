const statusEl = document.getElementById("status");
const seasonSelect = document.getElementById("season");
const table = document.getElementById("standings-table");
const tbody = table.querySelector("tbody");

function formatSeasonLabel(seasonId) {
  const start = seasonId.slice(0, 4);
  const end = seasonId.slice(4);
  return `${start}-${end}`;
}

// A team costing more than this (prior-season points, traded-away
// players subtracted — see computeTeamCost in teams.js) gets flagged on
// the Standings page, in case the pool enforces a salary-cap-style limit.
const COST_WARNING_THRESHOLD = 1000;

function computeStandings(season, teams, roster, previousRoster) {
  const rosterIndex = buildRosterIndex(roster);
  const previousRosterIndex = buildRosterIndex(previousRoster);

  const results = teams
    .map((team) => {
      let score = 0;
      const missing = [];
      const ambiguous = [];
      // Each credited player's own goals/assists/points, kept alongside
      // the team's summed score — lets renderStandings later diff against
      // the previous poll to describe *what* caused a score increase
      // (see describeScoreChange), not just that it happened.
      const playerBreakdown = [];
      team.players.forEach((entry) => {
        const name = playerName(entry);
        const tradeInfo = getTradeInfo(season, team.name, name);

        // A frozen exit snapshot doesn't need a live lookup at all, so
        // an ambiguous name elsewhere in the league can't affect it.
        if (tradeInfo.tradedOut) {
          const stats = creditedStats(tradeInfo, null);
          score += stats.points;
          playerBreakdown.push({ name, ...stats });
          return;
        }

        const { player, ambiguous: isAmbiguous } = resolvePlayer(
          rosterIndex, name, playerTeamHint(entry), playerPositionHint(entry), playerIdHint(entry)
        );

        if (isAmbiguous) {
          ambiguous.push(name);
          return;
        }

        const credited = creditedStats(tradeInfo, player);
        if (credited) {
          score += credited.points;
          playerBreakdown.push({ name, ...credited });
        } else if (!existsInRoster(previousRosterIndex, entry)) {
          // No stats yet is fine for anyone who was around last season;
          // only flag names we can't find in either.
          missing.push(name);
        }
      });
      const cost = computeTeamCost(season, team, previousRosterIndex);
      const activeCount = countActivePlayers(season, team);
      return { name: team.name, score, missing, ambiguous, cost, activeCount, playerBreakdown };
    })
    .sort((a, b) => b.score - a.score);

  // Standard competition ranking ("1, 1, 3, 4…") — teams tied on score
  // share the same rank, and the next distinct score picks up at the
  // count of teams ahead of it rather than simply the next integer.
  results.forEach((team, i) => {
    team.rank = i > 0 && team.score === results[i - 1].score ? results[i - 1].rank : i + 1;
  });

  return results;
}

// Gold/silver/bronze medal badge for the top 3 ranks — a flat colored
// disc with the number in a darker shade of the same hue, so it reads
// clearly against either a light or dark table background regardless
// of which theme is active (the badge's own colors provide the contrast,
// not the page's).
const MEDAL_STYLES = {
  1: { fill: "#f5c518", ring: "#c99a00", text: "#5c4400", label: "1st place" },
  2: { fill: "#c9ccd1", ring: "#9a9ea6", text: "#44474d", label: "2nd place" },
  3: { fill: "#d7883f", ring: "#a85f22", text: "#4a2c0d", label: "3rd place" },
};

function rankBadge(rank) {
  const s = MEDAL_STYLES[rank];
  if (!s) return null;
  return `<svg class="rank-medal" viewBox="0 0 32 32" width="26" height="26" role="img" aria-label="${s.label}">
    <circle cx="16" cy="16" r="14" fill="${s.fill}" stroke="${s.ring}" stroke-width="2"/>
    <text x="16" y="21" font-family="Arial, sans-serif" font-size="15" font-weight="700" fill="${s.text}" text-anchor="middle">${rank}</text>
  </svg>`;
}

// Wraps either the medal or a plain number in the same fixed-size box, so
// every row's rank cell is the same height and everything lines up —
// without it, rows 1-3 (26px icon) are taller than the rest (just text)
// and the whole column looks unevenly spaced.
function rankCell(rank, shine) {
  return `<span class="rank-value${shine ? " medal-shine" : ""}">${rankBadge(rank) || rank}</span>`;
}

// How long the score-flash highlight (and its event caption row, if any)
// stays on screen — kept in sync with the animation duration in style.css
// so the caption row is removed right as the highlight finishes fading.
const SCORE_FLASH_MS = 4000;

// Each team's score as of the last render — compared against on the next
// one so a row that just went up can get a brief flash (see renderStandings
// below). Reset to null whenever the season changes, so switching seasons
// never flashes rows that just happen to share a name.
let previousScores = null;

// Each team's per-player goals/assists as of the last render, keyed by
// "<team>::<player>" — compared on the next render (see
// describeScoreChange) to caption a flashing row with what actually
// happened, e.g. "Goal - Auston Matthews". Reset alongside previousScores.
let previousPlayerStats = null;

// Describes what changed for a team whose score just went up, by finding
// which of its players' goals/assists increased since the last render —
// { text, goals, assists }, where text is e.g. "Goal - Auston Matthews" or
// "Goal - Matthews, Assist - Hyman" if more than one contributed between
// polls, and goals/assists are the totals (they pick the row's goal-lamp
// vs assist highlight). Null if there's nothing to compare against yet,
// or (shouldn't normally happen) no player accounts for the change.
function describeScoreChange(team) {
  if (!previousPlayerStats) return null;
  const parts = [];
  let goals = 0, assists = 0;
  (team.playerBreakdown || []).forEach((p) => {
    const prev = previousPlayerStats.get(`${team.name}::${p.name}`);
    if (!prev) return;
    const deltaGoals = p.goals - prev.goals;
    const deltaAssists = p.assists - prev.assists;
    if (deltaGoals > 0) parts.push(`Goal${deltaGoals > 1 ? ` x${deltaGoals}` : ""} - ${p.name}`);
    if (deltaAssists > 0) parts.push(`Assist${deltaAssists > 1 ? ` x${deltaAssists}` : ""} - ${p.name}`);
    goals += Math.max(0, deltaGoals);
    assists += Math.max(0, deltaAssists);
  });
  return parts.length ? { text: parts.join(", "), goals, assists } : null;
}

// ---- Score effects ------------------------------------------------------

function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// Counts a score cell up from `from` to `to` (ease-out, longer for bigger
// jumps but capped), then gives the number a little pop. Instant when the
// user prefers reduced motion.
function animateScoreCount(el, from, to) {
  if (prefersReducedMotion() || from === to) {
    el.textContent = to.toLocaleString();
    return;
  }
  const duration = Math.min(1500, 400 + 120 * Math.abs(to - from));
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = Math.round(from + (to - from) * eased).toLocaleString();
    if (t < 1) {
      requestAnimationFrame(step);
    } else {
      el.classList.remove("score-pop");
      void el.offsetWidth; // restarts the pop if it was already applied
      el.classList.add("score-pop");
    }
  };
  requestAnimationFrame(step);
}

// Row highlight driven by hovering the chart (see history.js
// linkTeamHighlight) — kept here so it survives the tbody rebuild every
// render does. `color` is that team's line color on the chart.
let linkedRow = null; // { name, color } or null

function setLinkedRow(name, color) {
  linkedRow = name ? { name, color } : null;
  applyLinkedRow();
}

function applyLinkedRow() {
  tbody.querySelectorAll("tr.row-linked").forEach((tr) => tr.classList.remove("row-linked"));
  if (!linkedRow) return;
  const tr = [...tbody.querySelectorAll("tr[data-team]")].find((row) => row.dataset.team === linkedRow.name);
  if (!tr) return;
  tr.classList.add("row-linked");
  tr.style.setProperty("--link-color", linkedRow.color || "var(--accent)");
}

// Hovering a standings row highlights that team's line on the chart (and
// vice versa — see history.js). history.js loads after this file, so it's
// looked up at event time rather than referenced directly.
tbody.addEventListener("mouseover", (e) => {
  const tr = e.target.closest("tr[data-team]");
  if (tr && typeof linkTeamHighlight === "function") linkTeamHighlight(tr.dataset.team);
});
tbody.addEventListener("mouseleave", () => {
  if (typeof linkTeamHighlight === "function") linkTeamHighlight(null);
});

// Records each visible row's current position (keyed by team name, so it
// survives the full tbody rebuild every render does). Called before that
// rebuild; the positions are then used afterward to animate any row that
// ended up somewhere new — the "FLIP" technique (First/Last/Invert/Play).
function captureRowPositions() {
  const positions = new Map();
  tbody.querySelectorAll("tr").forEach((tr) => {
    const name = tr.querySelector(".team-name a")?.textContent;
    if (name) positions.set(name, tr.getBoundingClientRect().top);
  });
  return positions;
}

// Slides each row from where it used to be to its freshly-rendered
// position, rather than letting a reorder just jump straight there.
function animateRowReorder(oldPositions) {
  tbody.querySelectorAll("tr").forEach((tr) => {
    const name = tr.querySelector(".team-name a")?.textContent;
    if (!name || !oldPositions.has(name)) return;
    const delta = oldPositions.get(name) - tr.getBoundingClientRect().top;
    if (Math.abs(delta) < 1) return;

    tr.style.transition = "none";
    tr.style.transform = `translateY(${delta}px)`;
    // Two rAFs, not one — lets the browser actually paint the starting
    // (offset) position first, so the transition below has something to
    // animate from instead of jumping straight to the end state.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        tr.style.transition = "transform 400ms ease";
        tr.style.transform = "";
      });
    });
    tr.addEventListener("transitionend", () => { tr.style.transition = ""; }, { once: true });
  });
}

// ---- Rank-change moods ----------------------------------------------
// A team's logo briefly looks happy (hop + sparkle) after moving up the
// standings, or sad (droop + tear) after moving down. Pure CSS
// animations on the existing logo image (see .mood-happy/.mood-sad in
// style.css) — no extra artwork needed.

// Kept in sync with the longest mood animation in style.css, so the
// classes/effects are cleaned up right as it finishes.
const MOOD_MS = 3000;
// Each browser remembers the ranks it last showed (per season), so a
// returning visitor's logos react only to what changed since *their* last
// look. localStorage can be missing or blocked (private windows, etc.) —
// that just means no moods, never a broken page.
const RANKS_CACHE_KEY_PREFIX = "hockeypool-ranks:";

function loadCachedRanks(season) {
  try {
    const raw = localStorage.getItem(RANKS_CACHE_KEY_PREFIX + season);
    return raw ? new Map(Object.entries(JSON.parse(raw))) : null;
  } catch {
    return null;
  }
}

function saveCachedRanks(season, ranks) {
  if (typeof previewMode !== "undefined" && previewMode) return; // never save ?preview-fx's made-up ranks
  try {
    localStorage.setItem(RANKS_CACHE_KEY_PREFIX + season, JSON.stringify(Object.fromEntries(ranks)));
  } catch {
    // ignore (storage full/disabled)
  }
}

// Each team's rank as of the last render, for spotting live rank changes
// between polls. Reset alongside previousScores.
let previousRanks = null;

// Team name -> { mood: "happy" | "sad", from, to } for every team whose
// rank differs between `baseline` and `current` (teams missing from
// either are skipped).
function rankMoods(baseline, current) {
  const moods = new Map();
  if (!baseline) return moods;
  current.forEach((to, name) => {
    const from = baseline.get(name);
    if (from === undefined || from === to) return;
    moods.set(name, { mood: to < from ? "happy" : "sad", from, to });
  });
  return moods;
}

// Plays each team's mood animation on its logo in the rendered table.
function playMoods(moods) {
  if (!moods.size) return;
  tbody.querySelectorAll("tr").forEach((tr) => {
    const name = tr.querySelector(".team-name a")?.textContent;
    const wrap = tr.querySelector(".team-logo-wrap");
    const change = name && moods.get(name);
    if (!wrap || !change) return;

    const spots = Math.abs(change.to - change.from);
    wrap.title = `${change.mood === "happy" ? "▲ Up" : "▼ Down"} ${spots} spot${spots > 1 ? "s" : ""} (was #${change.from})`;
    const fx = document.createElement("span");
    fx.className = "mood-fx";
    fx.setAttribute("aria-hidden", "true");
    fx.textContent = change.mood === "happy" ? "✨" : "💧";
    wrap.appendChild(fx);
    wrap.classList.add(`mood-${change.mood}`);
    setTimeout(() => {
      wrap.classList.remove(`mood-${change.mood}`);
      fx.remove();
    }, MOOD_MS);
  });
}

// ?preview-moods in the URL plays both moods on load (top half happy,
// bottom half sad) — for seeing the animations without waiting for a
// real rank change.
function previewMoods(standings) {
  const moods = new Map();
  const half = Math.ceil(standings.length / 2);
  standings.forEach((team, i) => {
    moods.set(team.name, i < half
      ? { mood: "happy", from: team.rank + 1, to: team.rank }
      : { mood: "sad", from: team.rank, to: team.rank + 1 });
  });
  return moods;
}

// ?preview-fx in the URL demos the live-game effects without waiting
// for real games: shortly after the real standings render, a made-up
// update arrives — the second-placed team's first two players get a goal
// and an assist, the third's first player an assist — and goes through
// the exact same scoring/ranking/render path a real poll would (count-up,
// goal lamp, captions, rows sliding into their new order, medals, crown,
// rank moods). The chart's live point and the recap banner use the same
// made-up numbers. While previewing, the page stops polling (so the demo
// isn't overwritten by real data) and never saves the fake ranks.
const previewMode = new URLSearchParams(location.search).has("preview-fx");

// The made-up standings, for history.js's live chart point (see
// fetchLiveEntry) to use instead of real data while previewing.
let previewStandingsOverride = null;

function buildPreviewStandings(realStandings, season) {
  const teams = getTeamsForSeason(season);
  const playersOf = (name) => (teams.find((t) => t.name === name)?.players || []).map(playerName);
  // [player, goals, assists] credited to each team in this made-up update.
  const events = new Map();
  if (realStandings[1]) {
    const [a, b] = playersOf(realStandings[1].name);
    events.set(realStandings[1].name, [[a, 1, 0], [b, 0, 1]].filter(([n]) => n));
  }
  if (realStandings[2]) {
    const [a] = playersOf(realStandings[2].name);
    events.set(realStandings[2].name, [[a, 0, 1]].filter(([n]) => n));
  }

  const fake = realStandings.map((team) => {
    const breakdown = (team.playerBreakdown || []).map((p) => ({ ...p }));
    let score = team.score;
    (events.get(team.name) || []).forEach(([name, goals, assists]) => {
      // describeScoreChange diffs against the previous render's stats —
      // make sure these players have a baseline there to diff against.
      const key = `${team.name}::${name}`;
      if (previousPlayerStats && !previousPlayerStats.has(key)) previousPlayerStats.set(key, { goals: 0, assists: 0 });
      const prev = previousPlayerStats ? previousPlayerStats.get(key) : { goals: 0, assists: 0 };
      let entry = breakdown.find((p) => p.name === name);
      if (!entry) {
        entry = { name, goals: prev.goals, assists: prev.assists, points: prev.goals + prev.assists };
        breakdown.push(entry);
      }
      entry.goals += goals;
      entry.assists += assists;
      entry.points += goals + assists;
      score += goals + assists;
    });
    return { ...team, score, playerBreakdown: breakdown };
  });

  // Same sort + competition ranking as computeStandings.
  fake.sort((a, b) => b.score - a.score);
  fake.forEach((team, i) => {
    team.rank = i > 0 && team.score === fake[i - 1].score ? fake[i - 1].rank : i + 1;
  });
  return fake;
}

function runPreview(realStandings, season) {
  const fake = buildPreviewStandings(realStandings, season);
  previewStandingsOverride = fake.map((t) => ({ team: t.name, score: t.score }));
  renderStandings(fake, season);
  if (typeof renderChart === "function") renderChart(season);
  if (typeof showPreviewRecap === "function") showPreviewRecap(season, realStandings, fake);
}

function renderStandings(standings, season) {
  const topScore = standings.length ? standings[0].score : 0;
  // Only animate on a background poll update, not a fresh page/season
  // load — previousScores is null exactly when this is the latter (see
  // loadAndRender), same signal the score-flash effect keys off of.
  const oldPositions = previousScores ? captureRowPositions() : null;

  // Crown + medal shine for every team in first — including ties — once
  // the leaders have actually scored (not for everyone sitting at 0
  // before the season starts).
  const leadersHaveScored = standings.length > 0 && standings[0].score > 0;

  tbody.innerHTML = "";
  standings.forEach((team, i) => {
    const prevScore = previousScores ? previousScores.get(team.name) : undefined;
    const scoreIncreased = prevScore !== undefined && team.score > prevScore;
    const change = scoreIncreased ? describeScoreChange(team) : null;
    const isLeader = leadersHaveScored && team.rank === 1;
    // Blank for every team tied at rank 1 too, not just the literal first
    // row — nobody's "ahead" of them, ties included.
    const behindNext = team.rank === 1 ? "" : (standings[i - 1].score - team.score).toLocaleString();
    const behind1st = team.rank === 1 ? "" : (topScore - team.score).toLocaleString();
    const warningParts = [];
    if (team.missing.length) warningParts.push(`no data found for: ${team.missing.join(", ")}`);
    if (team.ambiguous.length) {
      warningParts.push(`multiple players named ${team.ambiguous.join(", ")} — add team/position in teams.js to disambiguate`);
    }
    if (team.cost > COST_WARNING_THRESHOLD) {
      warningParts.push(`total cost is ${team.cost.toLocaleString()}, over the ${COST_WARNING_THRESHOLD.toLocaleString()} limit`);
    }
    if (team.activeCount !== EXPECTED_ROSTER_SIZE) {
      warningParts.push(`roster has ${team.activeCount} current players, not ${EXPECTED_ROSTER_SIZE} (traded-away players don't count)`);
    }
    const warning = warningParts.length
      ? ` <span class="warn" title="${warningParts.join("; ")}">⚠</span>`
      : "";
    const teamHref = `team.html?name=${encodeURIComponent(team.name)}&season=${encodeURIComponent(season)}`;
    const logoSrc = getTeamLogo(season, team.name);
    // Wrapped so a rank-change mood (see playMoods) can position its
    // sparkle/tear effect relative to the logo.
    const crown = isLeader ? `<span class="leader-crown" title="Leader" aria-label="Leader">👑</span>` : "";
    const logo = logoSrc
      ? `<span class="team-logo-wrap">${crown}<img class="team-logo" src="${logoSrc}" alt="" width="28" height="28"></span>`
      : "";
    // Goal lamp (red) if any goal was scored since the last poll, a softer
    // blue if it was only assists — both replace the plain green flash.
    const lightClass = change && change.goals ? "goal-light" : change && change.assists ? "assist-light" : "";

    const tr = document.createElement("tr");
    tr.dataset.team = team.name;
    if (scoreIncreased) tr.classList.add("score-flash");
    if (lightClass) tr.classList.add(lightClass);
    tr.innerHTML = `
      <td class="num">${rankCell(team.rank, isLeader)}</td>
      <td class="team-logo-col">${logo}</td>
      <td class="team-name"><a href="${teamHref}">${team.name}</a>${warning}</td>
      <td class="num score"><span class="score-num">${(scoreIncreased ? prevScore : team.score).toLocaleString()}</span></td>
      <td class="num">${behindNext}</td>
      <td class="num">${behind1st}</td>
    `;
    tbody.appendChild(tr);
    // Count up from the previous score rather than jumping straight there.
    if (scoreIncreased) animateScoreCount(tr.querySelector(".score-num"), prevScore, team.score);

    // A separate full-width row rather than cramming this into the narrow
    // team-name cell — there's room for more than one contributor's name
    // here. Shares the same score-flash animation/timing as the row above
    // so the two read as one highlight, and is removed once that
    // animation ends rather than sticking around until the next poll.
    if (change) {
      const eventRow = document.createElement("tr");
      eventRow.className = `score-flash score-event-row ${lightClass}`;
      eventRow.innerHTML = `<td colspan="6"><div class="score-event">${change.text}</div></td>`;
      tbody.appendChild(eventRow);
      setTimeout(() => eventRow.remove(), SCORE_FLASH_MS);
    }
  });
  previousScores = new Map(standings.map((t) => [t.name, t.score]));
  previousPlayerStats = new Map();
  standings.forEach((team) => {
    (team.playerBreakdown || []).forEach((p) => {
      previousPlayerStats.set(`${team.name}::${p.name}`, { goals: p.goals, assists: p.assists });
    });
  });
  if (oldPositions) animateRowReorder(oldPositions);
  applyLinkedRow();

  // Live rank changes since the last poll. A fresh load has no previous
  // ranks — loadAndRender compares it against this browser's cached ranks
  // instead. Saved every render so a reload doesn't replay the same moods.
  const currentRanks = new Map(standings.map((t) => [t.name, t.rank]));
  if (previousRanks) playMoods(rankMoods(previousRanks, currentRanks));
  previousRanks = currentRanks;
  saveCachedRanks(season, currentRanks);

  statusEl.hidden = true;
  table.hidden = false;
}

function buildSeasonOptions() {
  const seasons = getPoolSeasons();
  seasonSelect.innerHTML = seasons
    .map((s) => `<option value="${s}">${formatSeasonLabel(s)}</option>`)
    .join("");

  const requestedSeason = new URLSearchParams(location.search).get("season");
  seasonSelect.value = seasons.includes(requestedSeason) ? requestedSeason : seasons[seasons.length - 1];
  // Nothing to choose between until a second season exists.
  document.getElementById("season-controls").hidden = seasons.length <= 1;
  return seasonSelect.value;
}

// Polling interval is just how often the UI checks in — the actual
// network cost is capped by fetchAllPlayersForSeason's own 5-minute
// cache regardless of how often this fires, so it's cheap to poll often.
const POLL_INTERVAL_MS = 60 * 1000;
let currentSeason = null;

async function loadAndRender(isInitialLoad) {
  // ?preview-fx: after the first render, the table shows made-up data —
  // don't let a background poll overwrite it with real data.
  if (previewMode && !isInitialLoad) return;
  if (isInitialLoad) {
    statusEl.hidden = false;
    statusEl.textContent = "Loading standings…";
    statusEl.classList.add("loading-pulse");
    previousScores = null; // a fresh load or season switch shouldn't flash anything
    previousPlayerStats = null;
    previousRanks = null;
  }

  try {
    const [roster, previousRoster] = await Promise.all([
      fetchAllPlayersForSeason(currentSeason),
      // Only used for the cost warning — a failure here shouldn't block
      // the standings themselves from rendering.
      fetchAllPlayersForSeason(previousSeasonId(currentSeason)).catch(() => []),
    ]);
    const standings = computeStandings(currentSeason, getTeamsForSeason(currentSeason), roster, previousRoster);
    // Read before rendering — renderStandings overwrites the cache.
    const cachedRanks = isInitialLoad ? loadCachedRanks(currentSeason) : null;
    renderStandings(standings, currentSeason);

    if (isInitialLoad) {
      if (previewMode) {
        setTimeout(() => runPreview(standings, currentSeason), 900);
      } else if (new URLSearchParams(location.search).has("preview-moods")) {
        setTimeout(() => playMoods(previewMoods(standings)), 400);
      } else {
        // Only what moved since this browser's last visit (nothing on a
        // first visit). Short delay so the table has visibly settled first.
        const currentRanks = new Map(standings.map((t) => [t.name, t.rank]));
        setTimeout(() => playMoods(rankMoods(cachedRanks, currentRanks)), 400);
      }
    }
  } catch (err) {
    // A background poll failing shouldn't disrupt an already-rendered
    // page — only surface the error if this was the initial load.
    if (isInitialLoad) {
      statusEl.classList.remove("loading-pulse");
      statusEl.textContent = `Error loading standings: ${err.message}`;
    }
  }
}

function startPolling() {
  setInterval(() => {
    if (document.visibilityState === "visible") loadAndRender(false);
  }, POLL_INTERVAL_MS);

  // Catch up immediately when the tab regains focus, rather than
  // waiting for the next tick.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") loadAndRender(false);
  });
}

async function init() {
  currentSeason = buildSeasonOptions();
  await loadAndRender(true);
  startPolling();

  seasonSelect.addEventListener("change", () => {
    currentSeason = seasonSelect.value;
    loadAndRender(true);
  });
}

init();
