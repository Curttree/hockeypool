const statusEl = document.getElementById("status");
const seasonLabelEl = document.getElementById("season-label");
const table = document.getElementById("standings-table");
const tbody = table.querySelector("tbody");

function formatSeasonLabel(seasonId) {
  const start = seasonId.slice(0, 4);
  const end = seasonId.slice(4);
  return `${start}-${end} Season`;
}

function computeStandings(teams, roster) {
  const pointsByName = new Map(roster.map((p) => [p.skaterFullName.toLowerCase(), p]));

  return teams
    .map((team) => {
      let score = 0;
      const missing = [];
      team.players.forEach((entry) => {
        const name = playerName(entry);
        const player = pointsByName.get(name.toLowerCase());
        if (player) {
          score += player.points;
        } else {
          missing.push(name);
        }
      });
      return { name: team.name, score, missing };
    })
    .sort((a, b) => b.score - a.score);
}

function renderStandings(standings) {
  const topScore = standings.length ? standings[0].score : 0;

  tbody.innerHTML = "";
  standings.forEach((team, i) => {
    const behindNext = i === 0 ? "" : (standings[i - 1].score - team.score).toLocaleString();
    const behind1st = i === 0 ? "" : (topScore - team.score).toLocaleString();
    const warning = team.missing.length
      ? ` <span class="warn" title="No data found for: ${team.missing.join(", ")}">⚠</span>`
      : "";

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="num">${i + 1}</td>
      <td class="team-name"><a href="team.html?name=${encodeURIComponent(team.name)}">${team.name}</a>${warning}</td>
      <td class="num score">${team.score.toLocaleString()}</td>
      <td class="num">${behindNext}</td>
      <td class="num">${behind1st}</td>
    `;
    tbody.appendChild(tr);
  });

  statusEl.hidden = true;
  table.hidden = false;
}

async function init() {
  statusEl.hidden = false;
  statusEl.textContent = "Loading standings…";

  try {
    const { season } = await fetch(`${API_BASE}/api/season`).then((r) => r.json());
    seasonLabelEl.textContent = formatSeasonLabel(season);

    const roster = await fetchAllPlayersForSeason(season);
    const standings = computeStandings(TEAMS, roster);
    renderStandings(standings);
  } catch (err) {
    statusEl.textContent = `Error loading standings: ${err.message}`;
  }
}

init();
