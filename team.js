const statusEl = document.getElementById("status");
const seasonLabelEl = document.getElementById("season-label");
const backLinkEl = document.getElementById("back-link");
const titleEl = document.getElementById("team-title");
const table = document.getElementById("team-table");
const tbody = table.querySelector("tbody");
const tfoot = table.querySelector("tfoot");
const lastNightHeaderEl = document.getElementById("last-night-header");

// Daily per-player season point totals, written by the snapshot Action
// (.github/scripts/snapshot-standings.mjs) — { [season]: [{ date, points:
// { [playerId]: points } }] }, oldest first, last two snapshots only.
const PLAYER_POINTS_URL = "data/player-points.json";

// Points scored between the two most recent snapshots. The Action runs
// overnight after the last game ends, so that's "last night" (or several
// nights, if a run was missed — the header tooltip shows the dates).
// Returns null when it can't be computed: fewer than two snapshots, or
// a player traded away (their credit is frozen, so nothing new counts).
function lastNightPoints(snapshots, playerId, tradeInfo) {
  if (!snapshots || snapshots.length < 2 || tradeInfo.tradedOut) return null;
  const [previous, latest] = snapshots.slice(-2);
  if (!playerId) return 0; // no NHL record at all — hasn't played
  const latestPoints = latest.points[playerId] || 0;
  let base = previous.points[playerId] || 0;
  // Acquired mid-season: only points after the trade count, so a trade
  // made between the two snapshots mustn't credit pre-trade points.
  if (tradeInfo.tradedIn) base = Math.max(base, tradeInfo.entry.points);
  return Math.max(0, latestPoints - base);
}

function updateLastNightHeader(snapshots) {
  // Missing only if a browser pairs a cached older team.html with this
  // script right after a deploy — not worth failing the page over.
  if (!lastNightHeaderEl) return;
  if (!snapshots || snapshots.length < 2) {
    lastNightHeaderEl.title = "Points from the most recent night of games — available after the first two daily snapshots";
    return;
  }
  const [previous, latest] = snapshots.slice(-2);
  lastNightHeaderEl.title = `Points from games between the ${previous.date} and ${latest.date} daily snapshots`;
}

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

// Each player's credited points as of the last render — compared against
// on the next one so a row whose score just went up can get a brief
// flash (see renderTeam below).
let previousPlayerScores = null;

async function init() {
  const params = new URLSearchParams(location.search);
  const teamName = params.get("name") || "";

  const seasons = getPoolSeasons();
  const requestedSeason = params.get("season");
  currentSeason = seasons.includes(requestedSeason) ? requestedSeason : seasons[seasons.length - 1];

  const team = findTeamByName(currentSeason, teamName);
  if (!team) {
    statusEl.classList.remove("loading-pulse");
    statusEl.textContent = teamName
      ? `No team found named "${teamName}" in the ${formatSeasonLabel(currentSeason)} season.`
      : "No team specified.";
    return;
  }

  const activeCount = countActivePlayers(currentSeason, team);
  const rosterWarning = activeCount !== EXPECTED_ROSTER_SIZE
    ? ` <span class="warn" title="Roster has ${activeCount} current players, not ${EXPECTED_ROSTER_SIZE} (traded-away players don't count)">⚠</span>`
    : "";
  const logoSrc = getTeamLogo(currentSeason, team.name);
  const logo = logoSrc ? `<img class="team-title-logo" src="${logoSrc}" alt="" width="40" height="40">` : "";
  titleEl.innerHTML = `${logo}<span>${team.name}${rosterWarning}</span>`;
  document.title = `Tremblay Hockey Pool - ${team.name}`;
  seasonLabelEl.textContent = `${formatSeasonLabel(currentSeason)} Season`;
  backLinkEl.href = `./?season=${encodeURIComponent(currentSeason)}`;

  await loadAndRender(team, true);
  startPolling(team);
  // NHL logo <img> srcs are baked in at render time (see nhlTeamLogo), so
  // a theme flip needs a re-render to pick up the matching light/dark set.
  window.addEventListener("themechange", () => loadAndRender(team, false));
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
  if (isInitialLoad) previousPlayerScores = null; // a fresh load shouldn't flash anything
  try {
    const [roster, injuries, previousRoster, pointsHistory] = await Promise.all([
      fetchAllPlayersForSeason(currentSeason),
      fetchInjuries(),
      // "Cost" is a nice-to-have, not part of scoring — a failure here
      // (e.g. no data at all for the prior season) shouldn't block the
      // rest of the page from rendering.
      fetchAllPlayersForSeason(previousSeasonId(currentSeason)).catch(() => []),
      // Same for "Last Night", which may simply not exist yet.
      fetch(PLAYER_POINTS_URL).then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
    ]);
    const pointsSnapshots = pointsHistory[currentSeason];
    updateLastNightHeader(pointsSnapshots);
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
      const previousPlayer = previousResolved.ambiguous ? null : previousResolved.player;
      const previousPoints = previousPlayer ? previousPlayer.points : null;

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
        previousTeam: previousPlayer ? previousPlayer.teamAbbrevs : null,
        lastNight: ambiguous
          ? null
          : lastNightPoints(
            pointsSnapshots,
            (player && player.playerId) || (previousPlayer && previousPlayer.playerId) || playerIdHint(entry),
            tradeInfo
          ),
        injured: manuallyFlagged || Boolean(liveInjury),
        injuryLabel: liveInjury ? (liveInjury.comment || liveInjury.status) : "Injured",
      };
    });

    const totalCost = computeTeamCost(currentSeason, team, previousRosterIndex);
    renderTeam(rows, totalCost);
  } catch (err) {
    // A background poll failing shouldn't disrupt an already-rendered
    // page — only surface the error if this was the initial load.
    if (isInitialLoad) {
      statusEl.classList.remove("loading-pulse");
      statusEl.textContent = `Error loading team: ${err.message}`;
    }
  }
}

// NHL team logo from the NHL's own asset CDN. It ships both "_dark"
// (drawn for dark backgrounds) and "_light" (for light backgrounds)
// variants of every team's mark — picking the one matching the current
// theme keeps thin/white-heavy logos from washing out. teamAbbrevs lists
// every team a player suited up for that season, e.g. "TOR,VGK" — the
// last one is their most recent. A logo that fails to load just removes
// itself, leaving the abbreviation.
function nhlTeamLogo(teamAbbrevs) {
  const abbrev = teamAbbrevs.split(",").pop().trim();
  const variant = document.documentElement.dataset.theme === "light" ? "light" : "dark";
  return `<img class="nhl-logo" src="https://assets.nhle.com/logos/nhl/svg/${abbrev}_${variant}.svg" alt="" width="26" height="26" onerror="this.remove()">`;
}

function renderTeam(rows, totalCost) {
  tbody.innerHTML = "";
  let totalScore = 0, totalGoals = 0, totalAssists = 0;
  let totalLastNight = null; // stays null (shown as "—") until any row has a value

  // Before a player's first game of the season (e.g. preseason) there's
  // no current-season record to read their team from, so fall back to
  // last season's team, muted and labelled as such. Anyone who moved in
  // the offseason shows their old team until they play.
  const previousSeasonLabel = formatSeasonLabel(previousSeasonId(currentSeason));
  const teamCell = (player, previousTeam) => {
    if (player) return `<td class="nhl-team">${nhlTeamLogo(player.teamAbbrevs)}${player.teamAbbrevs}</td>`;
    if (previousTeam) {
      return `<td class="nhl-team"><span class="prev-team" title="${previousSeasonLabel} team — updates once they play this season">${nhlTeamLogo(previousTeam)}${previousTeam}</span></td>`;
    }
    return "<td>—</td>";
  };

  const newPlayerScores = new Map();

  rows.forEach(({ name, injured, injuryLabel, player, tradedOut, tradedIn, ambiguous, credited, previousPoints, previousTeam, lastNight, noDataExpected }) => {
    if (credited) newPlayerScores.set(name, credited.points);
    const prevScore = previousPlayerScores ? previousPlayerScores.get(name) : undefined;
    const scoreIncreased = credited && prevScore !== undefined && credited.points > prevScore;
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
    if (lastNight != null) totalLastNight = (totalLastNight || 0) + lastNight;
    const lastNightCell = `<td class="num last-night${lastNight > 0 ? " scored" : ""}">${lastNight == null ? "—" : lastNight}</td>`;

    const tr = document.createElement("tr");
    if (scoreIncreased) tr.classList.add("score-flash");
    if (credited) {
      totalScore += credited.points;
      totalGoals += credited.goals;
      totalAssists += credited.assists;
      tr.innerHTML = `
        <td>${displayName}${injuryIcon}${acquiredBadge}${tradedBadge}</td>
        ${teamCell(player, previousTeam)}
        <td class="num score">${credited.points}</td>
        ${lastNightCell}
        <td class="num">${credited.goals}</td>
        <td class="num">${credited.assists}</td>
        ${costCell}
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
        ${teamCell(null, ambiguous ? null : previousTeam)}
        <td class="num score">0</td>
        ${lastNightCell}
        <td class="num">0</td>
        <td class="num">0</td>
        ${costCell}
      `;
    }
    tbody.appendChild(tr);
  });
  previousPlayerScores = newPlayerScores;

  tfoot.innerHTML = `
    <tr class="totals-row">
      <td colspan="2">Total</td>
      <td class="num score">${totalScore.toLocaleString()}</td>
      <td class="num last-night${totalLastNight > 0 ? " scored" : ""}">${totalLastNight == null ? "—" : totalLastNight.toLocaleString()}</td>
      <td class="num">${totalGoals.toLocaleString()}</td>
      <td class="num">${totalAssists.toLocaleString()}</td>
      <td class="num">${totalCost.toLocaleString()}</td>
    </tr>
  `;

  statusEl.hidden = true;
  table.hidden = false;
}

init();
