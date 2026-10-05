// Games page: today's and yesterday's NHL games that include at least one
// pool player, each shown as a compact scoreboard plus a table of those
// players' points (with an icon for every pool team that owns them).
// Scores/periods come from the NHL's per-date score feed, per-player points
// from each game's box score — both via the proxy (/api/scores and
// /api/boxscore in app.py / worker.js).

const statusEl = document.getElementById("status");
const gamesEl = document.getElementById("games");

// Same cadence as the Standings/Team pages. Unlike those, the data here
// really is refetched each tick (the proxy only caches for ~30s), but only
// for games still in progress — see fetchBoxscore.
const POLL_INTERVAL_MS = 60 * 1000;

// Per-point flash on a row whose points just went up (same effect as the
// Standings/Team pages). Keyed "<gameId>:<playerId>"; null until the first
// render, so a fresh page load never flashes anything.
let previousPoints = null;
let lastDays = null;

// External (NHL) strings end up in innerHTML below.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// Noon UTC so the day arithmetic can't be thrown off by a DST boundary.
function previousDate(dateStr) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function formatDay(dateStr) {
  return new Date(`${dateStr}T12:00:00Z`).toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" });
}

async function fetchJson(path) {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`${path} returned ${res.status}`);
  return res.json();
}

const LIVE_STATES = ["LIVE", "CRIT"];
const FINAL_STATES = ["FINAL", "OFF"];

// Anything that isn't clearly live or finished is treated as not started.
function gamePhase(state) {
  if (LIVE_STATES.includes(state)) return "live";
  if (FINAL_STATES.includes(state)) return "final";
  return "upcoming";
}

// A finished game's box score never changes, so it's only ever fetched
// once per page load; live games are refetched every poll. Judged by the
// box score's own state, not the score feed's — the proxy caches each
// separately, so the box score can briefly lag a game just going final.
const finishedBoxscores = new Map();

async function fetchBoxscore(game) {
  if (gamePhase(game.gameState) === "upcoming") return null;
  if (finishedBoxscores.has(game.id)) return finishedBoxscores.get(game.id);
  try {
    const box = await fetchJson(`/api/boxscore?id=${game.id}`);
    if (FINAL_STATES.includes(box.gameState)) finishedBoxscores.set(game.id, box);
    return box;
  } catch {
    return null; // this one game falls back to the roster-based list below
  }
}

// Every pool player resolved to their NHL playerId (the only thing a box
// score identifies players by), mapped to the pool teams that own them — a
// real player is often on several. Anyone with no stats yet this season is
// looked up in last season's roster instead, same as the Team page does.
function buildPoolPlayers(season, roster, previousRoster) {
  const rosterIndex = buildRosterIndex(roster);
  const previousRosterIndex = buildRosterIndex(previousRoster);
  const byId = new Map();

  getTeamsForSeason(season).forEach((team) => {
    team.players.forEach((entry) => {
      const name = playerName(entry);
      // Traded away: no longer really on this team.
      if (getTradeInfo(season, team.name, name).tradedOut) return;

      let resolved = resolvePlayer(rosterIndex, name, playerTeamHint(entry), playerPositionHint(entry), playerIdHint(entry));
      if (!resolved.ambiguous && !resolved.player) {
        resolved = resolvePlayer(previousRosterIndex, name, null, playerPositionHint(entry), playerIdHint(entry));
      }
      const player = resolved.ambiguous ? null : resolved.player;
      if (!player) return;

      if (!byId.has(player.playerId)) {
        byId.set(player.playerId, {
          name,
          nhlTeam: player.teamAbbrevs.split(",").pop().trim(),
          poolTeams: [],
        });
      }
      byId.get(player.playerId).poolTeams.push(team.name);
    });
  });
  return byId;
}

// The pool players in one game, most points first. Once a box score exists
// it's the source of truth (only players who actually dressed, with their
// real points). Before that — or if it couldn't be fetched — it's every
// pool player whose NHL team is in the game, with points not known yet.
function gamePlayers(game, box, poolPlayers) {
  const skaters = (side) => {
    const stats = box && box.playerByGameStats && box.playerByGameStats[side];
    return stats ? [...stats.forwards, ...stats.defense] : [];
  };
  const hasLineup = skaters("awayTeam").length + skaters("homeTeam").length > 0;

  let rows;
  if (hasLineup) {
    rows = [];
    ["awayTeam", "homeTeam"].forEach((side) => {
      skaters(side).forEach((p) => {
        const pool = poolPlayers.get(p.playerId);
        if (pool) {
          rows.push({ playerId: p.playerId, name: pool.name, nhlTeam: game[side].abbrev, points: p.points, poolTeams: pool.poolTeams });
        }
      });
    });
  } else {
    const inGame = [game.awayTeam.abbrev, game.homeTeam.abbrev];
    rows = [...poolPlayers]
      .filter(([, pool]) => inGame.includes(pool.nhlTeam))
      .map(([playerId, pool]) => ({ playerId, name: pool.name, nhlTeam: pool.nhlTeam, points: null, poolTeams: pool.poolTeams }));
  }

  return rows.sort((a, b) => (b.points ?? -1) - (a.points ?? -1) || a.name.localeCompare(b.name));
}

function ordinal(n) {
  return n === 1 ? "1st" : n === 2 ? "2nd" : n === 3 ? "3rd" : `${n}th`;
}

function statusText(game) {
  const phase = gamePhase(game.gameState);
  const period = game.periodDescriptor || {};

  if (phase === "upcoming") {
    return new Date(game.startTimeUTC).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  if (phase === "final") {
    return period.periodType === "OT" ? "Final/OT" : period.periodType === "SO" ? "Final/SO" : "Final";
  }
  if (period.periodType === "SO") return "Shootout";
  if (period.periodType === "OT") return "Overtime";
  return `${ordinal(period.number)} ${game.clock && game.clock.inIntermission ? "Intermission" : "Period"}`;
}

// A pool team's own logo, or its first letter if it doesn't have one.
function ownerIcon(season, teamName) {
  const logo = getTeamLogo(season, teamName);
  const label = esc(teamName);
  return logo
    ? `<img class="owner-icon" src="${logo}" alt="${label}" title="${label}" width="22" height="22">`
    : `<span class="owner-icon owner-fallback" title="${label}">${esc(teamName.charAt(0))}</span>`;
}

function gameTeamBlock(team, isLoser) {
  return `
    <div class="game-team${isLoser ? " is-loser" : ""}">
      <img class="game-team-logo" src="${esc(nhlLogoUrl(team.abbrev))}" alt="" width="48" height="48" onerror="this.remove()">
      <span class="game-team-name">${esc(team.name.default)}</span>
    </div>`;
}

// Renders one game card. `currentPoints` collects each player's points
// for the flash comparison on the next render.
function gameCard(season, { game, players }, currentPoints) {
  const phase = gamePhase(game.gameState);
  const { awayTeam: away, homeTeam: home } = game;
  const started = phase !== "upcoming";
  const final = phase === "final";

  const rows = players.map((p) => {
    const key = `${game.id}:${p.playerId}`;
    if (p.points != null) currentPoints.set(key, p.points);
    const before = previousPoints ? previousPoints.get(key) : undefined;
    const flash = before !== undefined && p.points > before ? " score-flash" : "";
    return `
      <tr class="${flash.trim()}">
        <td>${esc(p.name)}<span class="owner-icons">${p.poolTeams.map((t) => ownerIcon(season, t)).join("")}</span></td>
        <td class="nhl-team">${esc(p.nhlTeam)}</td>
        <td class="num score">${p.points == null ? "—" : p.points}</td>
      </tr>`;
  }).join("");

  return `
    <section class="game-card">
      <div class="game-scoreboard">
        ${gameTeamBlock(away, final && away.score < home.score)}
        <div class="game-center">
          <div class="game-status${phase === "live" ? " is-live" : ""}">${esc(statusText(game))}</div>
          <div class="game-score">${started ? `${away.score ?? 0} <span class="game-score-sep">-</span> ${home.score ?? 0}` : "@"}</div>
        </div>
        ${gameTeamBlock(home, final && home.score < away.score)}
      </div>
      <div class="table-scroll">
        <table class="game-players">
          <thead><tr><th>Player</th><th>Team</th><th class="num">Pts</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>`;
}

// `trackFlashes` is false for a theme-change redraw, which reuses the last
// fetched data — nothing new happened, so nothing should flash.
function render(season, days, trackFlashes) {
  const currentPoints = new Map();
  const html = days
    .filter((day) => day.entries.length)
    .map((day) => `
      <h2 class="games-day">${day.label} <span>${formatDay(day.date)}</span></h2>
      ${day.entries.map((entry) => gameCard(season, entry, currentPoints)).join("")}
    `).join("");

  gamesEl.innerHTML = html;
  if (trackFlashes) previousPoints = currentPoints;

  statusEl.classList.remove("loading-pulse");
  statusEl.hidden = Boolean(html);
  if (!html) statusEl.textContent = "No games today or yesterday include players from the pool.";
}

async function loadAndRender(season, isInitialLoad) {
  if (isInitialLoad) previousPoints = null; // a fresh load shouldn't flash anything

  try {
    // The NHL files games under their US Eastern date, so "today" and
    // "yesterday" are Eastern too.
    const today = easternDate();
    const dates = [today, previousDate(today)];
    const [roster, previousRoster, ...scoreboards] = await Promise.all([
      fetchAllPlayersForSeason(season),
      // Only for players with no stats yet this season — a failure here
      // shouldn't block the page.
      fetchAllPlayersForSeason(previousSeasonId(season)).catch(() => []),
      ...dates.map((date) => fetchJson(`/api/scores?date=${date}`)),
    ]);
    const poolPlayers = buildPoolPlayers(season, roster, previousRoster);

    const days = await Promise.all(dates.map(async (date, i) => {
      // Regular season only — it's the only thing the pool scores.
      const games = (scoreboards[i].games || [])
        .filter((g) => g.gameType === 2 && (g.gameScheduleState || "OK") === "OK")
        .sort((a, b) => a.startTimeUTC.localeCompare(b.startTimeUTC));
      const entries = await Promise.all(games.map(async (game) => ({
        game,
        players: gamePlayers(game, await fetchBoxscore(game), poolPlayers),
      })));
      return { date, label: i === 0 ? "Today" : "Yesterday", entries: entries.filter((e) => e.players.length) };
    }));

    lastDays = days;
    render(season, days, true);
  } catch (err) {
    // A background poll failing shouldn't disrupt an already-rendered
    // page — only surface the error if this was the initial load.
    if (isInitialLoad) {
      statusEl.classList.remove("loading-pulse");
      statusEl.textContent = `Error loading games: ${err.message}`;
    }
  }
}

async function init() {
  const seasons = getPoolSeasons();
  const season = seasons[seasons.length - 1];

  await loadAndRender(season, true);

  setInterval(() => {
    if (document.visibilityState === "visible") loadAndRender(season, false);
  }, POLL_INTERVAL_MS);

  // Catch up immediately when the tab regains focus, rather than
  // waiting for the next tick.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") loadAndRender(season, false);
  });

  // NHL logo <img> srcs are baked in at render time, so a theme flip
  // needs a redraw to pick up the matching light/dark set.
  window.addEventListener("themechange", () => {
    if (lastDays) render(season, lastDays, false);
  });
}

init();
