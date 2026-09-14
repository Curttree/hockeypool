const statusEl = document.getElementById("status");
const seasonLabelEl = document.getElementById("season-label");
const backLinkEl = document.getElementById("back-link");
const titleEl = document.getElementById("team-title");
const table = document.getElementById("team-table");
const tbody = table.querySelector("tbody");
const tfoot = table.querySelector("tfoot");

function formatSeasonLabel(seasonId) {
  const start = seasonId.slice(0, 4);
  const end = seasonId.slice(4);
  return `${start}-${end}`;
}

// "Connor McDavid" -> "McDavid, C" (matches the pool site's roster format)
function shortName(fullName, lastName) {
  const first = fullName.slice(0, fullName.length - lastName.length).trim();
  const initial = first.charAt(0);
  return `${lastName}, ${initial}`;
}

// Polling interval is just how often the UI checks in — the actual
// network cost is capped by fetchAllPlayersForSeason's/fetchInjuries's
// own 5-minute caches regardless of how often this fires, so it's cheap
// to poll often.
const POLL_INTERVAL_MS = 60 * 1000;
let currentSeason = null;

async function init() {
  const params = new URLSearchParams(location.search);
  const teamName = params.get("name") || "";

  const seasons = getPoolSeasons();
  const requestedSeason = params.get("season");
  currentSeason = seasons.includes(requestedSeason) ? requestedSeason : seasons[seasons.length - 1];

  const team = findTeamByName(currentSeason, teamName);
  if (!team) {
    statusEl.textContent = teamName
      ? `No team found named "${teamName}" in the ${formatSeasonLabel(currentSeason)} season.`
      : "No team specified.";
    return;
  }

  titleEl.textContent = team.name;
  document.title = `Tremblay Hockey Pool - ${team.name}`;
  seasonLabelEl.textContent = `${formatSeasonLabel(currentSeason)} Season`;
  backLinkEl.href = `/?season=${encodeURIComponent(currentSeason)}`;

  await loadAndRender(team, true);
  startPolling(team);
}

function startPolling(team) {
  setInterval(() => {
    if (document.visibilityState === "visible") loadAndRender(team, false);
  }, POLL_INTERVAL_MS);

  // Catch up immediately when the tab regains focus, rather than
  // waiting for the next tick.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") loadAndRender(team, false);
  });
}

async function loadAndRender(team, isInitialLoad) {
  try {
    const [roster, injuries] = await Promise.all([
      fetchAllPlayersForSeason(currentSeason),
      fetchInjuries(),
    ]);
    const pointsByName = new Map(roster.map((p) => [p.skaterFullName.toLowerCase(), p]));

    const rows = team.players.map((entry) => {
      const name = playerName(entry);
      const player = pointsByName.get(name.toLowerCase());
      const liveInjury = injuries.get(normalizePlayerName(name));
      const manuallyFlagged = playerIsInjured(entry);
      return {
        name,
        player,
        injured: manuallyFlagged || Boolean(liveInjury),
        injuryLabel: liveInjury ? (liveInjury.comment || liveInjury.status) : "Injured",
      };
    });

    renderTeam(rows);
  } catch (err) {
    // A background poll failing shouldn't disrupt an already-rendered
    // page — only surface the error if this was the initial load.
    if (isInitialLoad) statusEl.textContent = `Error loading team: ${err.message}`;
  }
}

function renderTeam(rows) {
  tbody.innerHTML = "";
  let totalScore = 0, totalGoals = 0, totalAssists = 0;

  rows.forEach(({ name, injured, injuryLabel, player }) => {
    const injuryTitle = (injuryLabel || "Injured").replace(/"/g, "&quot;");
    const injuryIcon = injured ? `<span class="injury-icon" title="${injuryTitle}">i</span>` : "";
    const displayName = player ? shortName(player.skaterFullName, player.lastName) : name;

    const tr = document.createElement("tr");
    if (player) {
      totalScore += player.points;
      totalGoals += player.goals;
      totalAssists += player.assists;
      tr.innerHTML = `
        <td>${displayName}${injuryIcon}</td>
        <td>${player.teamAbbrevs}</td>
        <td class="num score">${player.points}</td>
        <td class="num">${player.goals}</td>
        <td class="num">${player.assists}</td>
      `;
    } else {
      tr.innerHTML = `
        <td>${displayName}${injuryIcon} <span class="warn" title="No stats found for this player">⚠</span></td>
        <td>—</td>
        <td class="num score">0</td>
        <td class="num">0</td>
        <td class="num">0</td>
      `;
    }
    tbody.appendChild(tr);
  });

  tfoot.innerHTML = `
    <tr class="totals-row">
      <td colspan="2">Total</td>
      <td class="num score">${totalScore.toLocaleString()}</td>
      <td class="num">${totalGoals.toLocaleString()}</td>
      <td class="num">${totalAssists.toLocaleString()}</td>
    </tr>
  `;

  statusEl.hidden = true;
  table.hidden = false;
}

init();
