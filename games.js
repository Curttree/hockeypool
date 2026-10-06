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

// ---- Where to watch -----------------------------------------------------
// From the TV broadcasts the NHL lists on each game (tvBroadcasts). The ones
// that reach a viewer in Southwestern Ontario are shown as ways to watch; if
// there are none, the broadcasts listed for other regions are shown instead
// (labelled "Elsewhere", with the source and region in each tooltip). The
// feed can't say anything about blackouts or which TV package you have, so
// this is "who's showing it that you could plausibly get", not a guarantee.

// Canadian networks to offer a Southwestern Ontario viewer, by the NHL's
// network code. `logoId` is the NHL's own logo for it; the NHL has none for
// TSN, so that gets a plain text badge instead.
const WATCH_NETWORKS = {
  SN: { name: "Sportsnet", logoId: 282 },
  SN1: { name: "Sportsnet ONE", logoId: 284 },
  "SN+": { name: "Sportsnet+ (streaming)", logoId: 549 },
  Prime: { name: "Prime Video (streaming)", logoId: 548 },
  // The Maple Leafs' regional TSN feed, which covers Southwestern Ontario.
  // TSN2/3/5 are Montreal's, Winnipeg's and Ottawa's.
  TSN4: { name: "TSN4" },
};

// Canadian feeds that don't serve this viewer: other regions' Sportsnet feeds
// (which the NHL oddly files as national, so the market can't be trusted to
// rule them out) and the French-language ones. Any other TSN regional feed is
// dropped by the market rule in watchOptions.
const NOT_WATCHABLE = new Set(["SNW", "SNP", "SNE", "TVAS", "TVAS2", "RDS", "RDS2", "RDSI"]);

// Full names for networks the NHL only gives a code for — just the ones
// that are unambiguous. Anything else (mostly US regional sports networks)
// is shown under the NHL's own code rather than a guess.
const NETWORK_NAMES = {
  SNW: "Sportsnet West",
  SNP: "Sportsnet Pacific",
  SNE: "Sportsnet East",
  TVAS: "TVA Sports (French)",
  TVAS2: "TVA Sports 2 (French)",
  RDS: "RDS (French)",
  RDS2: "RDS2 (French)",
  RDSI: "RDS Info (French)",
  NHLN: "NHL Network",
  HULU: "Hulu",
  "HBO MAX": "HBO Max",
};

// The Sportsnet feeds the NHL files as "national" but that are really one
// region's.
const REGION_OVERRIDES = { SNW: "Western Canada", SNP: "Pacific Canada", SNE: "Eastern Canada" };
const COUNTRY_NAMES = { CA: "Canada", US: "United States" };

// Where a broadcast is shown. The NHL's market is "N" for national, or "H"/"A"
// for the home/away team's own territory.
function broadcastRegion(b, game) {
  if (REGION_OVERRIDES[b.network]) return REGION_OVERRIDES[b.network];
  const country = COUNTRY_NAMES[b.countryCode] || b.countryCode;
  if (b.market === "H") return `${game.homeTeam.name.default} market (home broadcast, ${country})`;
  if (b.market === "A") return `${game.awayTeam.name.default} market (away broadcast, ${country})`;
  return `${country}, nationwide`;
}

// The NHL's logo files are named by network id, as light/dark pairs.
function broadcastLogos(networkId) {
  const base = `https://assets.nhle.com/logos/broadcast/${networkId}`;
  return { light: `${base}-light.svg`, dark: `${base}-dark.svg` };
}

function watchOption(b, game) {
  const known = WATCH_NETWORKS[b.network];
  return {
    name: (known && known.name) || NETWORK_NAMES[b.network] || b.network,
    region: broadcastRegion(b, game),
    // The NHL only attaches logos to some listings; a known network falls
    // back to its own logo even if this particular listing has none.
    logos: known && known.logoId ? broadcastLogos(known.logoId) : b.logoUrls || null,
    badge: b.network,
    // Closest first among the "elsewhere" ones: Canada, then the US, then
    // anywhere else — nationwide before a team's own territory.
    closeness: (b.countryCode === "CA" ? 0 : b.countryCode === "US" ? 1 : 2) * 2 + (b.market === "N" ? 0 : 1),
  };
}

// Splits one game's listings into the ways to watch from Southwestern
// Ontario ("here") and everything else, for other regions ("elsewhere") —
// one entry per network, in the NHL's listed order. A Canadian network not in
// the table above counts as "here" only if it's national, otherwise it's some
// other region's feed.
function watchOptions(game) {
  const seen = new Set();
  const here = [];
  const elsewhere = [];
  (game.tvBroadcasts || []).forEach((b) => {
    if (seen.has(b.network)) return;
    seen.add(b.network);
    const reachesViewer = b.countryCode === "CA" && !NOT_WATCHABLE.has(b.network)
      && (Boolean(WATCH_NETWORKS[b.network]) || b.market === "N");
    (reachesViewer ? here : elsewhere).push(watchOption(b, game));
  });
  elsewhere.sort((a, b) => a.closeness - b.closeness);
  return { here, elsewhere };
}

function watchIcon(option) {
  const tip = esc(`${option.name} — ${option.region}`);
  return option.logos
    ? `<img class="watch-logo" src="${esc(themedLogoUrl(option.logos))}" alt="${esc(option.name)}" title="${tip}" height="18">`
    : `<span class="watch-badge" title="${tip}">${esc(option.badge)}</span>`;
}

// Only for games still to come or in progress — where it aired is no use
// once it's over.
function watchRow(game) {
  if (gamePhase(game.gameState) === "final") return "";
  const { here, elsewhere } = watchOptions(game);
  const row = (label, tip, items, extraClass = "") => `
      <div class="game-watch${extraClass}">
        <span class="watch-label" title="${esc(tip)}">${label}</span>${items}
      </div>`;

  if (here.length) {
    return row("Watch", "Broadcasts the NHL lists for this game that reach Southwestern Ontario. Blackouts and your TV package aren't accounted for.", here.map(watchIcon).join(""));
  }
  if (elsewhere.length) {
    return row("Elsewhere", "Nothing the NHL lists for this game reaches Southwestern Ontario. These are the broadcasts it lists for other regions — hover or tap one for its source and region.",elsewhere.map(watchIcon).join(""), " is-elsewhere");
  }
  return row("Watch", "The NHL lists no broadcast for this game.", `<span class="watch-none">No broadcast listed</span>`);
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
      </div>${watchRow(game)}
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
