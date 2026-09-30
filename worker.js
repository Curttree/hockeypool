/**
 * Cloudflare Worker: proxies requests to the NHL public APIs
 * (api.nhle.com stats and api-web.nhle.com live game data), which send
 * no CORS headers and so can't be called directly from a browser hosted
 * on GitHub Pages. /api/players and /api/season mirror the logic in
 * app.py, used for local development instead (app.py has no /api/live —
 * the site falls back to stats-only totals without it).
 *
 * Deploy: paste this file's contents into the Worker in the Cloudflare
 * dashboard (Workers & Pages > your worker > Edit code) and deploy, then
 * make sure common.js's WORKER_URL points at its *.workers.dev address.
 */

const NHL_API_BASE = "https://api.nhle.com/stats/rest/en/skater/summary";
const NHL_WEB_BASE = "https://api-web.nhle.com/v1";

// Maps the sort keys the frontend sends to the NHL API's property names.
const SORT_FIELDS = {
  player: "skaterFullName",
  team: "teamAbbrevs",
  pos: "positionCode",
  gp: "gamesPlayed",
  g: "goals",
  a: "assists",
  p: "points",
  plusMinus: "plusMinus",
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

// How long Cloudflare's edge cache (caches.default) may serve a response
// without re-checking the NHL API. A past season never changes, so an
// hour is fine there; the season in progress gets a much shorter window
// so finished games show up promptly.
const PLAYERS_CACHE_TTL = 3600; // 1 hour — completed seasons
const CURRENT_PLAYERS_CACHE_TTL = 300; // 5 minutes — the season being played
const SEASON_CACHE_TTL = 21600; // 6 hours — the "current season" boundary only flips a couple of times a year
const LIVE_CACHE_TTL = 60; // seconds — /api/live, i.e. in-progress games

// Game states (api-web.nhle.com) for games that have started — only these
// have player stats worth fetching.
const STARTED_GAME_STATES = new Set(["LIVE", "CRIT", "FINAL", "OFF"]);
const FINISHED_GAME_STATES = new Set(["FINAL", "OFF"]);
const REGULAR_SEASON = 2;

function jsonResponse(payload, status = 200, cacheSeconds = 0) {
  const headers = { "Content-Type": "application/json", ...CORS_HEADERS };
  if (cacheSeconds > 0) headers["Cache-Control"] = `public, max-age=${cacheSeconds}`;
  return new Response(JSON.stringify(payload), { status, headers });
}

// NHL seasons run roughly Oct-June. Returns the most recently completed
// season as an 8-digit id, e.g. "20252026".
function lastCompletedSeasonId() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1; // 1-12
  const [start, end] = month >= 7 ? [year - 1, year] : [year - 2, year - 1];
  return `${start}${end}`;
}

async function fetchPlayers({ season, limit, start, search, maxPoints, before, sortProp, sortDir }) {
  let cayenneExp = `gameTypeId=2 and seasonId=${season}`;

  if (search) {
    // Strip quotes/backslashes so user input can't break out of the
    // NHL API's cayenneExp query string.
    const safeSearch = search.replace(/["\\]/g, "");
    cayenneExp += ` and skaterFullName likeIgnoreCase "%${safeSearch}%"`;
  }
  if (maxPoints !== null) {
    cayenneExp += ` and points<=${maxPoints}`;
  }
  if (before) {
    // Only games before this date (already validated as YYYY-MM-DD) —
    // the site adds anything from this date on from /api/live instead.
    cayenneExp += ` and gameDate<"${before}"`;
  }

  const sortProperty = SORT_FIELDS[sortProp] || "points";
  const sortDirection = sortDir === "ASC" ? "ASC" : "DESC";
  const sortClauses = [{ property: sortProperty, direction: sortDirection }];
  if (sortProperty !== "points") {
    sortClauses.push({ property: "points", direction: "DESC" });
  }

  const params = new URLSearchParams({
    isAggregate: "false",
    isGame: "false",
    sort: JSON.stringify(sortClauses),
    start: String(start),
    limit: String(limit),
    factCayenneExp: "gamesPlayed>=1",
    cayenneExp,
  });

  const res = await fetch(`${NHL_API_BASE}?${params}`, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  return res.json();
}

async function handlePlayers(url) {
  const p = url.searchParams;
  const season = p.get("season") || lastCompletedSeasonId();
  const limit = parseInt(p.get("limit") || "50", 10);
  const start = parseInt(p.get("start") || "0", 10);
  const search = p.get("search") || "";
  const sortProp = p.get("sort") || "p";
  const sortDir = p.get("dir") || "DESC";

  let maxPoints = null;
  const maxPointsRaw = p.get("maxPoints");
  if (maxPointsRaw !== null && maxPointsRaw !== "") {
    maxPoints = parseInt(maxPointsRaw, 10);
    if (Number.isNaN(maxPoints)) {
      return jsonResponse({ error: "maxPoints must be an integer" }, 400);
    }
  }

  const before = p.get("before") || null;
  if (before !== null && !/^\d{4}-\d{2}-\d{2}$/.test(before)) {
    return jsonResponse({ error: "before must be a YYYY-MM-DD date" }, 400);
  }

  const cacheSeconds = season > lastCompletedSeasonId() ? CURRENT_PLAYERS_CACHE_TTL : PLAYERS_CACHE_TTL;

  try {
    const data = await fetchPlayers({ season, limit, start, search, maxPoints, before, sortProp, sortDir });
    return jsonResponse({
      season,
      players: data.data || [],
      total: data.total || 0,
      start,
      limit,
    }, 200, cacheSeconds);
  } catch (err) {
    return jsonResponse({ error: `Failed to reach NHL API: ${err.message}` }, 502);
  }
}

// GETs a JSON document from api-web.nhle.com, cached at Cloudflare's edge
// for `cacheTtl` seconds (per URL) so many visitors polling at once only
// cost one NHL request each window.
async function fetchWebJson(path, cacheTtl) {
  const res = await fetch(`${NHL_WEB_BASE}${path}`, {
    headers: { "User-Agent": "Mozilla/5.0" },
    cf: { cacheTtl, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`${path} returned ${res.status}`);
  return res.json();
}

// Live points from the NHL's current game date plus the previous date
// that had games — covering both tonight's games and last night's (which
// the stats API can take a while to include). Shape:
//   { season, from, dates, games: [...], players: [{ playerId, name,
//     team, goals, assists, points, gamesPlayed }] }
// The site pairs it with /api/players?before=<from>, so nothing is
// counted twice.
async function handleLive() {
  const now = await fetchWebJson("/score/now", LIVE_CACHE_TTL);
  const dates = [...new Set([now.prevDate, now.currentDate].filter(Boolean))].sort();
  const days = await Promise.all(dates.map((date) =>
    date === now.currentDate ? now : fetchWebJson(`/score/${date}`, LIVE_CACHE_TTL)
  ));

  const games = days
    .flatMap((day) => day.games || [])
    .filter((g) => g.gameType === REGULAR_SEASON && dates.includes(g.gameDate));
  const started = games.filter((g) => STARTED_GAME_STATES.has(g.gameState));

  const boxscores = await Promise.all(started.map((g) =>
    fetchWebJson(`/gamecenter/${g.id}/boxscore`, FINISHED_GAME_STATES.has(g.gameState) ? 600 : 15)
      .then((box) => ({ game: g, box }))
      .catch(() => null) // one bad game shouldn't sink the rest
  ));

  const players = new Map();
  boxscores.filter(Boolean).forEach(({ box }) => {
    ["awayTeam", "homeTeam"].forEach((side) => {
      const teamAbbrev = box[side] && box[side].abbrev;
      const stats = (box.playerByGameStats || {})[side] || {};
      [...(stats.forwards || []), ...(stats.defense || [])].forEach((p) => {
        const entry = players.get(p.playerId) || {
          playerId: p.playerId,
          name: p.name && p.name.default,
          team: teamAbbrev,
          goals: 0,
          assists: 0,
          points: 0,
          gamesPlayed: 0,
        };
        entry.goals += p.goals || 0;
        entry.assists += p.assists || 0;
        entry.points += (p.goals || 0) + (p.assists || 0);
        entry.gamesPlayed += 1;
        entry.team = teamAbbrev || entry.team;
        players.set(p.playerId, entry);
      });
    });
  });

  return jsonResponse({
    season: games.length ? String(games[0].season) : null,
    from: dates[0] || null,
    dates,
    games: games.map((g) => ({
      id: g.id,
      date: g.gameDate,
      state: g.gameState,
      away: g.awayTeam && g.awayTeam.abbrev,
      home: g.homeTeam && g.homeTeam.abbrev,
      awayScore: g.awayTeam && g.awayTeam.score,
      homeScore: g.homeTeam && g.homeTeam.score,
      // Lets the site skip polling until the next game actually starts.
      startTimeUTC: g.startTimeUTC,
    })),
    players: [...players.values()],
  }, 200, LIVE_CACHE_TTL);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const isCacheableRoute = ["/api/players", "/api/season", "/api/live"].includes(url.pathname);

    // Cloudflare's edge cache: keyed on the full request (method + URL),
    // so each distinct combination of query params is cached separately.
    // Only takes effect once actually deployed to Cloudflare's network.
    if (request.method === "GET" && isCacheableRoute) {
      const cache = caches.default;
      const cached = await cache.match(request);
      if (cached) return cached;
    }

    let response;
    try {
      if (url.pathname === "/api/players") {
        response = await handlePlayers(url);
      } else if (url.pathname === "/api/season") {
        response = jsonResponse({ season: lastCompletedSeasonId() }, 200, SEASON_CACHE_TTL);
      } else if (url.pathname === "/api/live") {
        response = await handleLive();
      } else {
        response = jsonResponse({ error: "Not found" }, 404);
      }
    } catch (err) {
      response = jsonResponse({ error: `Failed to reach NHL API: ${err.message}` }, 502);
    }

    if (request.method === "GET" && isCacheableRoute && response.status === 200) {
      ctx.waitUntil(caches.default.put(request, response.clone()));
    }
    return response;
  },
};
