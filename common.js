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

// Fetches the full-season roster (~900+ skaters) in a single request —
// limit=-1 tells the NHL API to return every row. Don't paginate this:
// the proxy has no stable unique sort key (it silently ignores unknown
// ones like "id"), and without one, separately-fetched pages overlap, so
// some players get duplicated and others dropped entirely.
async function fetchAllPlayersForSeason(season) {
  const cached = getCachedRoster(season);
  if (cached) return cached;

  const params = new URLSearchParams({ season, limit: -1, start: 0, sort: "player", dir: "ASC" });
  const { players } = await fetch(`${API_BASE}/api/players?${params}`).then((r) => r.json());

  setCachedRoster(season, players);
  return players;
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

// Tap-to-show tooltips. Touch devices have no hover, so the native
// `title` tooltips on these icons/badges never appear on mobile. Tapping
// one shows its title text in a small popover instead; tapping anywhere
// else (or scrolling) closes it. Works on desktop clicks too. Uses event
// delegation since table rows are re-rendered on every refresh.
const TAP_TIP_SELECTOR = ".injury-icon, .warn, .traded-badge, .prev-team, #last-night-header";
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
