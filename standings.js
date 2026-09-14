const statusEl = document.getElementById("status");
const seasonSelect = document.getElementById("season");
const table = document.getElementById("standings-table");
const tbody = table.querySelector("tbody");

function formatSeasonLabel(seasonId) {
  const start = seasonId.slice(0, 4);
  const end = seasonId.slice(4);
  return `${start}-${end}`;
}

function computeStandings(season, teams, roster) {
  const rosterIndex = buildRosterIndex(roster);

  return teams
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
          rosterIndex, name, playerTeamHint(entry), playerPositionHint(entry)
        );

        if (isAmbiguous) {
          ambiguous.push(name);
          return;
        }

        const credited = creditedStats(tradeInfo, player);
        if (credited) {
          score += credited.points;
        } else {
          missing.push(name);
        }
      });
      return { name: team.name, score, missing, ambiguous };
    })
    .sort((a, b) => b.score - a.score);
}

function renderStandings(standings, season) {
  const topScore = standings.length ? standings[0].score : 0;

  tbody.innerHTML = "";
  standings.forEach((team, i) => {
    const behindNext = i === 0 ? "" : (standings[i - 1].score - team.score).toLocaleString();
    const behind1st = i === 0 ? "" : (topScore - team.score).toLocaleString();
    const warningParts = [];
    if (team.missing.length) warningParts.push(`no data found for: ${team.missing.join(", ")}`);
    if (team.ambiguous.length) {
      warningParts.push(`multiple players named ${team.ambiguous.join(", ")} — add team/position in teams.js to disambiguate`);
    }
    const warning = warningParts.length
      ? ` <span class="warn" title="${warningParts.join("; ")}">⚠</span>`
      : "";
    const teamHref = `team.html?name=${encodeURIComponent(team.name)}&season=${encodeURIComponent(season)}`;
    const logoSrc = getTeamLogo(season, team.name);
    const logo = logoSrc ? `<img class="team-logo" src="${logoSrc}" alt="" width="28" height="28">` : "";

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="num">${i + 1}</td>
      <td class="team-logo-col">${logo}</td>
      <td class="team-name"><a href="${teamHref}">${team.name}</a>${warning}</td>
      <td class="num score">${team.score.toLocaleString()}</td>
      <td class="num">${behindNext}</td>
      <td class="num">${behind1st}</td>
    `;
    tbody.appendChild(tr);
  });

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
  }

  try {
    const roster = await fetchAllPlayersForSeason(currentSeason);
    const standings = computeStandings(currentSeason, getTeamsForSeason(currentSeason), roster);
    renderStandings(standings, currentSeason);
  } catch (err) {
    // A background poll failing shouldn't disrupt an already-rendered
    // page — only surface the error if this was the initial load.
    if (isInitialLoad) statusEl.textContent = `Error loading standings: ${err.message}`;
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
