const statusEl = document.getElementById("status");
const seasonLabelEl = document.getElementById("season-label");
const titleEl = document.getElementById("team-title");
const table = document.getElementById("team-table");
const tbody = table.querySelector("tbody");
const tfoot = table.querySelector("tfoot");

function formatSeasonLabel(seasonId) {
  const start = seasonId.slice(0, 4);
  const end = seasonId.slice(4);
  return `${start}-${end} Season`;
}

// "Connor McDavid" -> "McDavid, C" (matches the pool site's roster format)
function shortName(fullName, lastName) {
  const first = fullName.slice(0, fullName.length - lastName.length).trim();
  const initial = first.charAt(0);
  return `${lastName}, ${initial}`;
}

function init() {
  const teamName = new URLSearchParams(location.search).get("name") || "";
  const team = findTeamByName(teamName);

  if (!team) {
    statusEl.textContent = teamName
      ? `No team found named "${teamName}".`
      : "No team specified.";
    return;
  }

  titleEl.textContent = team.name;
  document.title = `Tremblay Hockey Pool - ${team.name}`;
  loadRoster(team);
}

async function loadRoster(team) {
  try {
    const { season } = await fetch(`${API_BASE}/api/season`).then((r) => r.json());
    seasonLabelEl.textContent = formatSeasonLabel(season);

    const [roster, injuries] = await Promise.all([
      fetchAllPlayersForSeason(season),
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
    statusEl.textContent = `Error loading team: ${err.message}`;
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
