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

  const activeCount = countActivePlayers(currentSeason, team);
  const rosterWarning = activeCount !== EXPECTED_ROSTER_SIZE
    ? ` <span class="warn" title="Roster has ${activeCount} current players, not ${EXPECTED_ROSTER_SIZE} (traded-away players don't count)">⚠</span>`
    : "";
  titleEl.innerHTML = `${team.name}${rosterWarning}`;
  document.title = `Tremblay Hockey Pool - ${team.name}`;
  seasonLabelEl.textContent = `${formatSeasonLabel(currentSeason)} Season`;
  backLinkEl.href = `./?season=${encodeURIComponent(currentSeason)}`;

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
    const [roster, injuries, previousRoster] = await Promise.all([
      fetchAllPlayersForSeason(currentSeason),
      fetchInjuries(),
      // "Cost" is a nice-to-have, not part of scoring — a failure here
      // (e.g. no data at all for the prior season) shouldn't block the
      // rest of the page from rendering.
      fetchAllPlayersForSeason(previousSeasonId(currentSeason)).catch(() => []),
    ]);
    const rosterIndex = buildRosterIndex(roster);
    const previousRosterIndex = buildRosterIndex(previousRoster);

    const rows = team.players.map((entry) => {
      const name = playerName(entry);
      const liveInjury = injuries.get(normalizePlayerName(name));
      const manuallyFlagged = playerIsInjured(entry);
      const tradeInfo = getTradeInfo(currentSeason, team.name, name);
      const resolved = resolvePlayer(rosterIndex, name, playerTeamHint(entry), playerPositionHint(entry), playerIdHint(entry));

      // A frozen exit snapshot doesn't need a live lookup for scoring —
      // an ambiguous name elsewhere in the league shouldn't block it,
      // so only treat ambiguity as blocking when we actually need the
      // live lookup to know their credited stats at all.
      const ambiguous = !tradeInfo.tradedOut && resolved.ambiguous;
      const player = resolved.ambiguous ? null : resolved.player;
      const credited = ambiguous ? null : creditedStats(tradeInfo, player);

      // Team hint is dropped here — a player's team last season may
      // well differ from the (current-season) hint in teams.js.
      const previousResolved = resolvePlayer(previousRosterIndex, name, null, playerPositionHint(entry), playerIdHint(entry));
      const previousPoints = !previousResolved.ambiguous && previousResolved.player
        ? previousResolved.player.points
        : null;

      // No live stats yet is fine for anyone who was around last season.
      const noDataExpected = existsInRoster(previousRosterIndex, entry);

      return {
        name,
        player,
        noDataExpected,
        tradedOut: tradeInfo.tradedOut,
        tradedIn: tradeInfo.tradedIn,
        ambiguous,
        credited,
        previousPoints,
        injured: manuallyFlagged || Boolean(liveInjury),
        injuryLabel: liveInjury ? (liveInjury.comment || liveInjury.status) : "Injured",
      };
    });

    const totalCost = computeTeamCost(currentSeason, team, previousRosterIndex);
    renderTeam(rows, totalCost);
  } catch (err) {
    // A background poll failing shouldn't disrupt an already-rendered
    // page — only surface the error if this was the initial load.
    if (isInitialLoad) statusEl.textContent = `Error loading team: ${err.message}`;
  }
}

function renderTeam(rows, totalCost) {
  tbody.innerHTML = "";
  let totalScore = 0, totalGoals = 0, totalAssists = 0;

  rows.forEach(({ name, injured, injuryLabel, player, tradedOut, tradedIn, ambiguous, credited, previousPoints, noDataExpected }) => {
    const injuryTitle = (injuryLabel || "Injured").replace(/"/g, "&quot;");
    const injuryIcon = injured ? `<span class="injury-icon" title="${injuryTitle}">i</span>` : "";
    const acquiredBadge = tradedIn
      ? `<span class="traded-badge" title="Acquired via trade — stats before joining this team don't count">Acquired</span>`
      : "";
    const tradedBadge = tradedOut
      ? `<span class="traded-badge" title="Traded away — stats locked as of the trade">Traded</span>`
      : "";
    const displayName = player ? shortName(player.skaterFullName, player.lastName) : name;
    const costCell = `<td class="num" title="Points scored the previous season">${previousPoints == null ? "—" : previousPoints}</td>`;

    const tr = document.createElement("tr");
    if (credited) {
      totalScore += credited.points;
      totalGoals += credited.goals;
      totalAssists += credited.assists;
      tr.innerHTML = `
        <td>${displayName}${injuryIcon}${acquiredBadge}${tradedBadge}</td>
        <td>${player ? player.teamAbbrevs : "—"}</td>
        ${costCell}
        <td class="num score">${credited.points}</td>
        <td class="num">${credited.goals}</td>
        <td class="num">${credited.assists}</td>
      `;
    } else {
      const warningTitle = ambiguous
        ? "Multiple players share this name — add team/position in teams.js to disambiguate"
        : "No stats found for this player";
      const warningIcon = noDataExpected && !ambiguous
        ? ""
        : ` <span class="warn" title="${warningTitle}">⚠</span>`;
      tr.innerHTML = `
        <td>${displayName}${injuryIcon}${acquiredBadge}${tradedBadge}${warningIcon}</td>
        <td>—</td>
        ${costCell}
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
      <td class="num">${totalCost.toLocaleString()}</td>
      <td class="num score">${totalScore.toLocaleString()}</td>
      <td class="num">${totalGoals.toLocaleString()}</td>
      <td class="num">${totalAssists.toLocaleString()}</td>
    </tr>
  `;

  statusEl.hidden = true;
  table.hidden = false;
}

init();
