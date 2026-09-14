// Shared across pages: which backend to call, and fetching/caching a
// full-season skater roster (used by both the Player Selector's "Fill to
// 20" and the Standings page's score calculation).

// Fill this in with your deployed Cloudflare Worker's *.workers.dev URL
// (see worker.js) after publishing to GitHub Pages. Localhost keeps using
// the relative /api paths served by app.py.
const WORKER_URL = "https://hockeypool-proxy.curttremblay.workers.dev";
const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname);
const API_BASE = isLocal ? "" : WORKER_URL;

// In-memory + sessionStorage cache for full-season rosters, so repeated
// fetches (or a page reload within the same tab) don't re-issue the ~10
// paginated requests every time within a short window. Kept short so an
// in-progress season's standings feel current.
const ROSTER_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const ROSTER_CACHE_KEY_PREFIX = "nhl-points-roster-cache:";
const rosterCache = new Map();

function getCachedRoster(season) {
  if (rosterCache.has(season)) return rosterCache.get(season);
  try {
    const raw = sessionStorage.getItem(ROSTER_CACHE_KEY_PREFIX + season);
    if (raw) {
      const { timestamp, players } = JSON.parse(raw);
      if (Date.now() - timestamp < ROSTER_CACHE_TTL_MS) {
        rosterCache.set(season, players);
        return players;
      }
    }
  } catch {
    // ignore (storage disabled/corrupt)
  }
  return null;
}

function setCachedRoster(season, players) {
  rosterCache.set(season, players);
  try {
    sessionStorage.setItem(ROSTER_CACHE_KEY_PREFIX + season, JSON.stringify({ timestamp: Date.now(), players }));
  } catch {
    // ignore (storage full/disabled)
  }
}

// The NHL API caps each request at 100 rows, so a full-season roster
// (~900+ skaters) needs to be paginated. Sorting by playerId (unique per
// player) rather than points avoids a real bug: with points as the sort
// key, players tied on points at a page boundary can be dropped or
// duplicated, since ties have no guaranteed stable order across separate
// paginated requests.
async function fetchAllPlayersForSeason(season) {
  const cached = getCachedRoster(season);
  if (cached) return cached;

  const pageSize = 100;
  const pageParams = (start) => new URLSearchParams({ season, limit: pageSize, start, sort: "id", dir: "ASC" });
  const first = await fetch(`${API_BASE}/api/players?${pageParams(0)}`).then((r) => r.json());
  const all = [...first.players];
  const starts = [];
  for (let s = pageSize; s < first.total; s += pageSize) starts.push(s);

  const rest = await Promise.all(starts.map((s) =>
    fetch(`${API_BASE}/api/players?${pageParams(s)}`).then((r) => r.json())
  ));
  rest.forEach((page) => all.push(...page.players));

  setCachedRoster(season, all);
  return all;
}

// Groups a roster fetch by lowercased full name, so a name shared by
// more than one player in the league (it happens — e.g. two different
// "Elias Pettersson"s) can be detected instead of one silently
// overwriting the other in a plain name->player map.
function buildRosterIndex(roster) {
  const index = new Map();
  roster.forEach((p) => {
    const key = p.skaterFullName.toLowerCase();
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(p);
  });
  return index;
}

// Resolves one player by name against a roster index built above.
// teamHint/positionHint (both optional, e.g. "VAN"/"C" — see teams.js)
// narrow the match when more than one player shares that name.
// Returns one of:
//   { player, ambiguous: false }              - resolved (0 or 1 match)
//   { player: null, ambiguous: true, candidates } - still >1 match
function resolvePlayer(rosterIndex, name, teamHint, positionHint) {
  const candidates = rosterIndex.get(name.toLowerCase()) || [];
  if (candidates.length <= 1) {
    return { player: candidates[0] || null, ambiguous: false };
  }

  let filtered = candidates;
  if (teamHint) {
    filtered = filtered.filter((p) => p.teamAbbrevs.split(",").includes(teamHint));
  }
  if (positionHint) {
    filtered = filtered.filter((p) => p.positionCode === positionHint);
  }

  if (filtered.length === 1) {
    return { player: filtered[0], ambiguous: false };
  }
  return { player: null, ambiguous: true, candidates: filtered.length ? filtered : candidates };
}

// Live injury status. The NHL's own API has no injury/status field at
// all (checked the roster and player-landing endpoints), so this uses
// ESPN's unofficial site API instead — it's undocumented and could
// change or be blocked without notice, so failures here are handled by
// just showing no injury data rather than breaking the page.
const ESPN_INJURIES_URL = "https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/injuries";
const INJURY_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const INJURY_CACHE_KEY = "nhl-points-injury-cache";

// Names come from two different providers (NHL's API and ESPN's), so
// match loosely: lowercase and strip accents ("Tim Stützle" vs a possible
// ASCII "Tim Stutzle").
function normalizePlayerName(name) {
  return name
    .normalize("NFD")
    .replace(/\p{Mark}/gu, "")
    .toLowerCase()
    .trim();
}

async function fetchInjuries() {
  try {
    const raw = sessionStorage.getItem(INJURY_CACHE_KEY);
    if (raw) {
      const { timestamp, entries } = JSON.parse(raw);
      if (Date.now() - timestamp < INJURY_CACHE_TTL_MS) return new Map(entries);
    }
  } catch {
    // ignore (storage disabled/corrupt)
  }

  try {
    const data = await fetch(ESPN_INJURIES_URL).then((r) => r.json());
    const entries = [];
    (data.injuries || []).forEach((team) => {
      (team.injuries || []).forEach((injury) => {
        const name = injury.athlete && injury.athlete.displayName;
        if (!name) return;
        entries.push([normalizePlayerName(name), {
          status: injury.status || "Injured",
          comment: injury.shortComment || injury.longComment || "",
        }]);
      });
    });

    try {
      sessionStorage.setItem(INJURY_CACHE_KEY, JSON.stringify({ timestamp: Date.now(), entries }));
    } catch {
      // ignore (storage full/disabled)
    }

    return new Map(entries);
  } catch {
    return new Map();
  }
}
