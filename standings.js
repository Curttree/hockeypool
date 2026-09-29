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
      team.players.forEach((entry) => {
        const name = playerName(entry);
        const tradeInfo = getTradeInfo(season, team.name, name);

        // A frozen exit snapshot doesn't need a live lookup at all, so
        // an ambiguous name elsewhere in the league can't affect it.
        if (tradeInfo.tradedOut) {
          score += creditedStats(tradeInfo, null).points;
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
        } else if (!existsInRoster(previousRosterIndex, entry)) {
          // No stats yet is fine for anyone who was around last season;
          // only flag names we can't find in either.
          missing.push(name);
        }
      });
      const cost = computeTeamCost(season, team, previousRosterIndex);
      const activeCount = countActivePlayers(season, team);
      return { name: team.name, score, missing, ambiguous, cost, activeCount };
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
function rankCell(rank) {
  return `<span class="rank-value">${rankBadge(rank) || rank}</span>`;
}

// Each team's score as of the last render — compared against on the next
// one so a row that just went up can get a brief flash (see renderStandings
// below). Reset to null whenever the season changes, so switching seasons
// never flashes rows that just happen to share a name.
let previousScores = null;

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

function renderStandings(standings, season) {
  const topScore = standings.length ? standings[0].score : 0;
  // Only animate on a background poll update, not a fresh page/season
  // load — previousScores is null exactly when this is the latter (see
  // loadAndRender), same signal the score-flash effect keys off of.
  const oldPositions = previousScores ? captureRowPositions() : null;

  tbody.innerHTML = "";
  standings.forEach((team, i) => {
    const prevScore = previousScores ? previousScores.get(team.name) : undefined;
    const scoreIncreased = prevScore !== undefined && team.score > prevScore;
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
    const logo = logoSrc ? `<img class="team-logo" src="${logoSrc}" alt="" width="28" height="28">` : "";

    const tr = document.createElement("tr");
    if (scoreIncreased) tr.classList.add("score-flash");
    tr.innerHTML = `
      <td class="num">${rankCell(team.rank)}</td>
      <td class="team-logo-col">${logo}</td>
      <td class="team-name"><a href="${teamHref}">${team.name}</a>${warning}</td>
      <td class="num score">${team.score.toLocaleString()}</td>
      <td class="num">${behindNext}</td>
      <td class="num">${behind1st}</td>
    `;
    tbody.appendChild(tr);
  });
  previousScores = new Map(standings.map((t) => [t.name, t.score]));
  if (oldPositions) animateRowReorder(oldPositions);

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
  if (isInitialLoad) {
    statusEl.hidden = false;
    statusEl.textContent = "Loading standings…";
    statusEl.classList.add("loading-pulse");
    previousScores = null; // a fresh load or season switch shouldn't flash anything
  }

  try {
    const [roster, previousRoster] = await Promise.all([
      fetchAllPlayersForSeason(currentSeason),
      // Only used for the cost warning — a failure here shouldn't block
      // the standings themselves from rendering.
      fetchAllPlayersForSeason(previousSeasonId(currentSeason)).catch(() => []),
    ]);
    const standings = computeStandings(currentSeason, getTeamsForSeason(currentSeason), roster, previousRoster);
    renderStandings(standings, currentSeason);
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
