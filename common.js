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
// fetches (or a page reload within the same tab) don't re-download
// the whole roster every time within a short window. Kept short so an
// in-progress season's standings feel current.
const ROSTER_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
// A roster that includes live game data (see fetchLive) goes stale much
// faster — goals happen by the minute. Two minutes keeps Worker requests
// modest (see worker.js) while still feeling live.
const LIVE_ROSTER_CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes
const ROSTER_CACHE_KEY_PREFIX = "nhl-points-roster-cache:";
const rosterCache = new Map(); // season -> { expiresAt, players }

function getCachedRoster(season) {
  let entry = rosterCache.get(season);
  if (!entry) {
    try {
      const raw = sessionStorage.getItem(ROSTER_CACHE_KEY_PREFIX + season);
      if (raw) entry = JSON.parse(raw);
    } catch {
      // ignore (storage disabled/corrupt)
    }
  }
  if (entry && entry.expiresAt > Date.now() && Array.isArray(entry.players)) {
    rosterCache.set(season, entry);
    return entry.players;
  }
  return null;
}

function setCachedRoster(season, players, ttlMs = ROSTER_CACHE_TTL_MS) {
  const entry = { expiresAt: Date.now() + ttlMs, players };
  rosterCache.set(season, entry);
  try {
    sessionStorage.setItem(ROSTER_CACHE_KEY_PREFIX + season, JSON.stringify(entry));
  } catch {
    // ignore (storage full/disabled)
  }
}

// Live points from in-progress and just-finished games (worker.js's
// /api/live): per-player goals/assists for the NHL's current game date
// and the previous one that had games, plus `from` (the earliest of
// those dates). The stats API only includes games after they end — and
// can lag behind even then — so season totals are fetched from before
// `from` and these are added on top, never counting a game twice.
// Returns null if the backend has no /api/live (app.py locally, or a
// Worker that hasn't been redeployed yet) — callers then fall back to
// stats-only totals. Shared for a few seconds so fetching two seasons at
// once doesn't make two requests.
//
// If a request fails (a Cloudflare limit, a network blip), the last good
// response is reused instead — otherwise tonight's live points would
// briefly vanish from everyone's totals and pop back a refresh later.
// Kept in sessionStorage too, so a reload mid-blip doesn't lose it; only
// reused for LIVE_FALLBACK_MAX_AGE_MS, after which stats-only totals are
// the safer bet.
const LIVE_FALLBACK_KEY = "nhl-points-last-live";
const LIVE_FALLBACK_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes

function saveLastLive(data) {
  try {
    sessionStorage.setItem(LIVE_FALLBACK_KEY, JSON.stringify({ savedAt: Date.now(), data }));
  } catch {
    // ignore (storage full/disabled)
  }
}

function loadLastLive() {
  try {
    const raw = sessionStorage.getItem(LIVE_FALLBACK_KEY);
    if (!raw) return null;
    const { savedAt, data } = JSON.parse(raw);
    return Date.now() - savedAt < LIVE_FALLBACK_MAX_AGE_MS ? data : null;
  } catch {
    return null;
  }
}

let liveRequest = null;
let liveRequestAt = 0;
function fetchLive() {
  if (!liveRequest || Date.now() - liveRequestAt > 10 * 1000) {
    liveRequestAt = Date.now();
    liveRequest = fetch(`${API_BASE}/api/live`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => (data && data.from && Array.isArray(data.players) ? data : null))
      .catch(() => null)
      .then((data) => {
        if (data) {
          saveLastLive(data);
          return data;
        }
        const last = loadLastLive();
        // Flagged so liveRefreshMs retries soon rather than trusting an
        // old schedule to decide when to check again.
        return last ? { ...last, reused: true } : null;
      });
  }
  return liveRequest;
}

// How long live data can be reused before anything could have changed —
// i.e. how long until the site needs to ask /api/live again:
//   - a game is on (or warming up, or past its start time): every
//     LIVE_ROSTER_CACHE_TTL_MS
//   - nothing on yet: until shortly before the next scheduled start
//   - nothing on at all (all final, off days, offseason): hourly, which
//     also picks up the next day's schedule once the NHL posts it
// Never longer than LIVE_IDLE_MAX_MS, never shorter than the live rate.
const LIVE_IDLE_MAX_MS = 60 * 60 * 1000; // 1 hour
const LIVE_PREGAME_LEAD_MS = 2 * 60 * 1000; // start checking 2 minutes early
const ACTIVE_GAME_STATES = new Set(["PRE", "LIVE", "CRIT"]);

function liveRefreshMs(live) {
  if (!live || live.reused) return LIVE_ROSTER_CACHE_TTL_MS; // retry soon after an error
  const now = Date.now();
  const games = live.games || [];
  const startOf = (g) => (g.startTimeUTC ? Date.parse(g.startTimeUTC) : NaN);
  const underway = games.some((g) =>
    ACTIVE_GAME_STATES.has(g.state) || (g.state === "FUT" && startOf(g) <= now)
  );
  if (underway) return LIVE_ROSTER_CACHE_TTL_MS;

  const upcoming = games.filter((g) => g.state === "FUT");
  // An upcoming game with no start time (a Worker that predates
  // startTimeUTC) — can't tell when it starts, so keep polling normally.
  if (upcoming.some((g) => Number.isNaN(startOf(g)))) return LIVE_ROSTER_CACHE_TTL_MS;
  const nextStart = Math.min(...upcoming.map(startOf));
  const untilNext = Number.isFinite(nextStart) ? nextStart - LIVE_PREGAME_LEAD_MS - now : LIVE_IDLE_MAX_MS;
  return Math.max(LIVE_ROSTER_CACHE_TTL_MS, Math.min(LIVE_IDLE_MAX_MS, untilNext));
}

// True for a season that's already over (NHL seasons wrap up by June) —
// no live games to check for, and its totals never change. Same rule as
// worker.js's lastCompletedSeasonId.
function isCompletedSeason(season) {
  const now = new Date();
  const year = now.getUTCFullYear();
  const lastCompletedEnd = now.getUTCMonth() + 1 >= 7 ? year : year - 1;
  return parseInt(String(season).slice(4), 10) <= lastCompletedEnd;
}

// "William Nylander" -> "w. nylander" — how live box scores name players.
function abbreviatedNameKey(fullName) {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length < 2) return fullName.toLowerCase();
  return `${parts[0].charAt(0)}. ${parts.slice(1).join(" ")}`.toLowerCase();
}

// Adds live game points onto season-to-date totals (matched by NHL
// playerId). Anyone in the live data but not the totals — e.g. everyone,
// on opening night — gets a new record; their full name comes from
// `knownPlayers` (another season's roster) when possible, else the box
// score's abbreviated one ("W. Nylander"), which resolvePlayer can still
// match against a full name.
function mergeLivePlayers(basePlayers, livePlayers, knownPlayers) {
  const byId = new Map(basePlayers.map((p) => [p.playerId, { ...p }]));
  const knownById = new Map(knownPlayers.map((p) => [p.playerId, p]));
  livePlayers.forEach((lp) => {
    const existing = byId.get(lp.playerId);
    if (existing) {
      existing.goals += lp.goals;
      existing.assists += lp.assists;
      existing.points += lp.points;
      existing.gamesPlayed += lp.gamesPlayed;
      existing.byDate = lp.byDate; // per-night split, for the Standings "Tonight" column
      return;
    }
    const known = knownById.get(lp.playerId);
    const abbreviated = !known;
    byId.set(lp.playerId, {
      playerId: lp.playerId,
      skaterFullName: known ? known.skaterFullName : lp.name,
      lastName: known ? known.lastName : lp.name.replace(/^\S+\s+/, ""),
      positionCode: known ? known.positionCode : undefined,
      teamAbbrevs: lp.team,
      goals: lp.goals,
      assists: lp.assists,
      points: lp.points,
      gamesPlayed: lp.gamesPlayed,
      byDate: lp.byDate,
      liveOnly: true,
      nameIsAbbreviated: abbreviated,
    });
  });
  return [...byId.values()];
}

// Fetches the full-season roster (~900+ skaters) in a single request —
// limit=-1 tells the NHL API to return every row. Don't paginate this:
// the proxy has no stable unique sort key (it silently ignores unknown
// ones like "id"), and without one, separately-fetched pages overlap, so
// some players get duplicated and others dropped entirely. For the season
// being played, live game points (fetchLive) are merged in when the
// backend supports it.
//
// Concurrent calls for the same season (e.g. the standings table and the
// chart on page load) share one in-flight request instead of each
// fetching before the other's result is cached.
const rosterRequests = new Map(); // season -> in-flight Promise
function fetchAllPlayersForSeason(season) {
  const cached = getCachedRoster(season);
  if (cached) return Promise.resolve(cached);
  const key = String(season);
  if (!rosterRequests.has(key)) {
    rosterRequests.set(key, loadRosterForSeason(season).finally(() => rosterRequests.delete(key)));
  }
  return rosterRequests.get(key);
}

async function loadRosterForSeason(season) {
  if (isCompletedSeason(season)) {
    const params = new URLSearchParams({ season, limit: -1, start: 0, sort: "player", dir: "ASC" });
    const { players } = await fetch(`${API_BASE}/api/players?${params}`).then((r) => r.json());
    setCachedRoster(season, players, LIVE_IDLE_MAX_MS); // final — nothing to refresh
    return players;
  }

  const live = await fetchLive();
  const useLive = Boolean(live && live.season === String(season));

  const params = new URLSearchParams({ season, limit: -1, start: 0, sort: "player", dir: "ASC" });
  if (useLive) params.set("before", live.from);
  const { players } = await fetch(`${API_BASE}/api/players?${params}`).then((r) => r.json());

  if (!useLive) {
    // No games in the live window at all (e.g. the offseason) — totals
    // can't move, so there's no need to keep asking every few minutes.
    const idle = live && !live.reused && live.season === null;
    setCachedRoster(season, players, idle ? LIVE_IDLE_MAX_MS : ROSTER_CACHE_TTL_MS);
    return players;
  }

  // Full names for anyone who only appears in the live data.
  // (Computed here rather than via teams.js's previousSeasonId — the
  // Players page loads this file without teams.js.)
  const priorSeason = `${parseInt(String(season).slice(0, 4), 10) - 1}${parseInt(String(season).slice(4), 10) - 1}`;
  const knownPlayers = await fetchAllPlayersForSeason(priorSeason).catch(() => []);
  const merged = mergeLivePlayers(players, live.players, knownPlayers);
  setCachedRoster(season, merged, liveRefreshMs(live));
  return merged;
}

// Groups a roster fetch by lowercased full name, so a name shared by
// more than one player in the league (it happens — e.g. two different
// "Elias Pettersson"s) can be detected instead of one silently
// overwriting the other in a plain name->player map.
//
// The NHL sometimes lists a nickname in parentheses, e.g.
// "John (Jack) Roslovic" — those are also indexed as "Jack Roslovic" and
// "John Roslovic" so either spelling in teams.js still matches. Each
// player is also indexed by "#<playerId>" for teams.js entries that pin
// an `id` (see resolvePlayer).
function buildRosterIndex(roster) {
  const index = new Map();
  const add = (key, p) => {
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(p);
  };
  roster.forEach((p) => {
    const fullName = p.skaterFullName.toLowerCase();
    const keys = new Set([fullName]);
    const nickname = fullName.match(/^(.*?)\s*\(([^)]+)\)\s*(.*)$/);
    if (nickname) {
      const [, given, nick, rest] = nickname;
      keys.add(`${nick} ${rest}`.trim());
      keys.add(`${given} ${rest}`.trim());
    }
    keys.forEach((key) => add(key, p));
    add(`#${p.playerId}`, p);
    // Live-only records named like "W. Nylander" (see mergeLivePlayers)
    // also go under a separate abbreviated key for resolvePlayer's
    // fallback — never mixed in with full-name matches.
    if (p.nameIsAbbreviated) add(`~${fullName}`, p);
  });
  return index;
}

// Resolves one player by name against a roster index built above.
// idHint (optional NHL playerId — see teams.js) wins outright when set,
// so a player still resolves if the NHL changes how it spells their
// name. teamHint/positionHint (both optional, e.g. "VAN"/"C") narrow
// the match when more than one player shares that name.
// Returns one of:
//   { player, ambiguous: false }              - resolved (0 or 1 match)
//   { player: null, ambiguous: true, candidates } - still >1 match
function resolvePlayer(rosterIndex, name, teamHint, positionHint, idHint) {
  if (idHint) {
    const [player] = rosterIndex.get(`#${idHint}`) || [];
    return { player: player || null, ambiguous: false };
  }
  let candidates = rosterIndex.get(name.toLowerCase()) || [];
  // No full-name match: try a live-only player known just by an
  // abbreviated name, e.g. "W. Nylander" for "William Nylander".
  if (!candidates.length) candidates = rosterIndex.get(`~${abbreviatedNameKey(name)}`) || [];
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

// "YYYY-MM-DD" in US Eastern time for a moment (default: now) — the
// calendar the NHL files its games under (a 10pm ET puck drop is still
// that evening's game even once it's the next day in UTC), whatever
// timezone the viewer is in.
function easternDate(moment = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(moment)
      .map((p) => [p.type, p.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// NHL team logo URL from the NHL's own asset CDN. It ships both "_dark"
// (drawn for dark backgrounds) and "_light" (for light backgrounds)
// variants of every team's mark — picking the one matching the current
// theme keeps thin/white-heavy logos from washing out. Callers bake this
// into the DOM at render time, so they re-render on the "themechange"
// event (see initTheme below) to pick up the other set.
function nhlLogoUrl(abbrev) {
  const variant = document.documentElement.dataset.theme === "light" ? "light" : "dark";
  return `https://assets.nhle.com/logos/nhl/svg/${abbrev}_${variant}.svg`;
}

// The day before a "YYYY-MM-DD" date. Done at noon UTC so the arithmetic
// can't be thrown off by a DST boundary.
function previousDate(dateStr) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// Same idea for a logo the NHL supplies as a { light, dark } pair of URLs —
// e.g. a TV network's `logoUrls` on a game's tvBroadcasts entry.
function themedLogoUrl(logoUrls) {
  return logoUrls[document.documentElement.dataset.theme === "light" ? "light" : "dark"];
}

// Tap-to-show tooltips. Touch devices have no hover, so the native
// `title` tooltips on these icons/badges never appear on mobile. Tapping
// one shows its title text in a small popover instead; tapping anywhere
// else (or scrolling) closes it. Works on desktop clicks too. Uses event
// delegation since table rows are re-rendered on every refresh.
const TAP_TIP_SELECTOR = ".injury-icon, .warn, .traded-badge, .prev-team, #last-night-header, .watch-label, .watch-logo, .watch-badge";
let tapTipEl = null;
let tapTipAnchor = null;

function hideTapTip() {
  if (tapTipEl) tapTipEl.hidden = true;
  tapTipAnchor = null;
}

function showTapTip(anchor) {
  if (!tapTipEl) {
    tapTipEl = document.createElement("div");
    tapTipEl.className = "tap-tip";
    tapTipEl.setAttribute("role", "tooltip");
    document.body.appendChild(tapTipEl);
  }
  tapTipEl.textContent = anchor.getAttribute("title");
  tapTipEl.hidden = false;
  tapTipAnchor = anchor;

  // Center under the anchor, clamped to the viewport with an 8px margin;
  // flip above it if there's no room below.
  const a = anchor.getBoundingClientRect();
  const t = tapTipEl.getBoundingClientRect();
  const left = Math.min(Math.max(8, a.left + a.width / 2 - t.width / 2), document.documentElement.clientWidth - t.width - 8);
  const below = a.bottom + 6;
  const top = below + t.height > document.documentElement.clientHeight - 8 ? a.top - t.height - 6 : below;
  tapTipEl.style.left = `${left + window.scrollX}px`;
  tapTipEl.style.top = `${top + window.scrollY}px`;
}

document.addEventListener("click", (e) => {
  const anchor = e.target.closest(TAP_TIP_SELECTOR);
  if (anchor && anchor.getAttribute("title") && anchor !== tapTipAnchor) {
    showTapTip(anchor);
  } else {
    hideTapTip();
  }
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideTapTip(); });
// Capture phase so scrolling inside the (horizontally scrollable) table
// closes it too, not just page scrolls.
document.addEventListener("scroll", hideTapTip, { capture: true, passive: true });
window.addEventListener("resize", hideTapTip);

// Adds a right-edge fade to any `.table-scroll` container that's
// actually scrollable, as a hint there's more to see — recalculated on
// resize and whenever a table's content changes (season switches,
// filtering, live score updates, etc.), since that's all this app ever
// does to these tables rather than removing them from the page.
function updateScrollShadows() {
  document.querySelectorAll(".table-scroll").forEach((el) => {
    const overflowing = el.scrollWidth > el.clientWidth + 1;
    // Only shown at the untouched starting position — once the user has
    // scrolled at all, they already know it's scrollable, so drop the
    // fade rather than have it sit over the middle of the content.
    el.classList.toggle("is-scrollable", overflowing && el.scrollLeft <= 1);
  });
}
window.addEventListener("resize", updateScrollShadows);
// Capture phase so a scroll inside the table itself (not just the page)
// is caught too.
document.addEventListener("scroll", updateScrollShadows, { capture: true, passive: true });
new MutationObserver(updateScrollShadows).observe(document.body, { childList: true, subtree: true });
updateScrollShadows();

// Light/dark toggle. The saved preference is also applied synchronously by
// an inline <script> at the top of each page's <head> (before style.css
// takes effect), so there's no flash of the wrong theme on load — this
// just keeps that in sync and wires up the button.
const THEME_KEY = "nhl-points-theme";

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelectorAll(".theme-toggle").forEach((btn) => {
    // Icon shows the theme a click switches *to*, so dark shows a sun
    // and light shows a moon — both plain currentColor strokes, so they
    // pick up the same muted/text colors as the rest of the nav instead
    // of an emoji's own fixed colors.
    const showSun = theme !== "light";
    // Not `.hidden = ...` — SVGElement doesn't reflect that IDL property
    // to the actual attribute the way HTMLElement does, so it would
    // silently no-op and never actually change what's rendered.
    btn.querySelector(".icon-sun").toggleAttribute("hidden", !showSun);
    btn.querySelector(".icon-moon").toggleAttribute("hidden", showSun);
    btn.setAttribute("aria-label", theme === "light" ? "Switch to dark theme" : "Switch to light theme");
  });
}

function initTheme() {
  let saved = null;
  try {
    saved = localStorage.getItem(THEME_KEY);
  } catch {
    // ignore (storage disabled)
  }
  applyTheme(saved === "light" ? "light" : "dark");

  document.querySelectorAll(".theme-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
      try {
        localStorage.setItem(THEME_KEY, next);
      } catch {
        // ignore (storage disabled)
      }
      applyTheme(next);
      // Lets the standings chart (Chart.js colors aren't CSS-driven) know
      // to re-render itself with the new theme's colors.
      window.dispatchEvent(new CustomEvent("themechange", { detail: { theme: next } }));
    });
  });
}
initTheme();
