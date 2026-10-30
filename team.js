const statusEl = document.getElementById("status");
const seasonLabelEl = document.getElementById("season-label");
const backLinkEl = document.getElementById("back-link");
const titleEl = document.getElementById("team-title");
const table = document.getElementById("team-table");
const tbody = table.querySelector("tbody");
const tfoot = table.querySelector("tfoot");
const lastNightHeaderEl = document.getElementById("last-night-header");
const tonightHeaderEl = document.getElementById("tonight-header");

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

// Whether the snapshots have caught up with last night: the newest is for
// last night (or later) and the two newest are consecutive days. If not,
// "Last Night" from them would be a night behind, or span several nights
// because one was missed. (The same test the Standings recap uses.)
function snapshotsCoverLastNight(snapshots, night) {
  if (!snapshots || snapshots.length < 2) return false;
  const [previous, latest] = snapshots.slice(-2);
  return latest.date >= night && previous.date === previousDate(latest.date);
}

// A player's points for one night from the live data: what they're
// credited at the end of that night minus at the end of the night before —
// the same scoring the standings use, so a trade is handled the same way
// (nothing counts from before the player joined this team) and a column's
// total matches the recap / Standings. `indexes` are roster indexes as of
// the end of each of those nights (rosterThrough). Used for "Last Night"
// when the snapshots haven't caught up, and always for "Tonight".
// Null for a player traded away: their credit is frozen.
function liveNightPoints(entry, tradeInfo, indexes) {
  if (tradeInfo.tradedOut) return null;
  const creditedAt = (index) => {
    const { player, ambiguous } = resolvePlayer(index, playerName(entry), playerTeamHint(entry), playerPositionHint(entry), playerIdHint(entry));
    const credited = ambiguous ? null : creditedStats(tradeInfo, player);
    return credited ? Math.max(0, credited.points) : 0;
  };
  return Math.max(0, creditedAt(indexes.through) - creditedAt(indexes.before));
}

// The night the "Tonight" column covers, or null when it shouldn't show —
// the same rule as the Standings page's Tonight column: none of the current
// night's games has started yet (the live data lists a player under a night
// from the moment their game starts, even at 0 points), or the daily
// snapshots already cover the night, in which case "Last Night" reports it
// and this column waits for the next night's first game.
function tonightNight(roster, snapshots) {
  const night = currentNightDate();
  if (!roster.some((p) => p.byDate && p.byDate[night])) return null;
  const newest = snapshots && snapshots.length ? snapshots[snapshots.length - 1].date : null;
  return newest && newest >= night ? null : night;
}

// `liveNight` is the night the live data is standing in for, if it is.
function updateLastNightHeader(snapshots, liveNight) {
  // Missing only if a browser pairs a cached older team.html with this
  // script right after a deploy — not worth failing the page over.
  if (!lastNightHeaderEl) return;
  if (liveNight) {
    lastNightHeaderEl.title = `Points from last night's games (${liveNight}), from live data — the daily snapshot hasn't caught up yet`;
    return;
  }
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

// Polling interval is just how often the UI checks in — the actual
// network cost is capped by fetchAllPlayersForSeason's/fetchInjuries's
// own 5-minute caches regardless of how often this fires, so it's cheap
// to poll often.
const POLL_INTERVAL_MS = 60 * 1000;
let currentSeason = null;

// The injury icon: two crossed bandages. The one underneath is masked with a
// gap around the one on top (rather than filled with a background color) so
// it looks right on any row color.
// (The mask goes on an unrotated wrapper: its coordinates follow the element
// it's applied to, so on the rotated group itself the gap would turn too.)
const BANDAGE_SHAPE = `<rect x="1.5" y="8.8" width="21" height="6.4" rx="3.2"/>`;
const BANDAGE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><mask id="bandage-gap" maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24"><rect width="24" height="24" fill="#fff" stroke="none"/><g transform="rotate(45 12 12)" fill="#000" stroke="#000" stroke-width="3.6">${BANDAGE_SHAPE}</g></mask><g mask="url(#bandage-gap)"><g transform="rotate(-45 12 12)">${BANDAGE_SHAPE}</g></g><g transform="rotate(45 12 12)">${BANDAGE_SHAPE}<path d="M7.2 8.8v6.4M16.8 8.8v6.4"/></g></svg>`;

// Each player's credited points/goals/assists as of the last render —
// compared against on the next one so a row whose score just went up can
// get a brief goal- or assist-light flash and count its score up (see
// renderTeam below). The totals row's score likewise.
let previousPlayerStats = null;
let previousTotalScore = null;

function reducedMotion() {
  return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// Counts a number's text from `from` to `to` (ease-out), optionally after
// a delay and ending with a little pop (the .score-pop class the Standings
// page uses). The final value is always written, and nothing animates for
// people who prefer reduced motion.
function countUp(el, from, to, { delay = 0, duration = 700, prefix = "", pop = false } = {}) {
  const text = (n) => `${prefix}${n.toLocaleString()}`;
  // A tab nobody is looking at doesn't run animation frames, so it would
  // sit at the starting number — show the real one instead.
  if (reducedMotion() || from === to || document.visibilityState === "hidden") {
    el.textContent = text(to);
    return;
  }
  // Hold the number's final width while it counts. Otherwise the column
  // (a totals-row cell like Cost goes from "0" to "1,000") grows with it
  // and the whole table drifts left as it does.
  el.textContent = text(to);
  const finalWidth = Math.ceil(el.getBoundingClientRect().width);
  el.style.display = "inline-block";
  el.style.minWidth = `${finalWidth}px`;
  el.style.textAlign = "right";
  el.textContent = text(from);
  const begin = performance.now() + delay;
  const step = (now) => {
    const t = Math.max(0, Math.min(1, (now - begin) / duration));
    el.textContent = text(Math.round(from + (to - from) * (1 - Math.pow(1 - t, 3))));
    if (t < 1) {
      requestAnimationFrame(step);
      return;
    }
    el.style.display = el.style.minWidth = el.style.textAlign = "";
    if (pop) {
      el.classList.remove("score-pop");
      void el.offsetWidth; // restarts the pop if it was already applied
      el.classList.add("score-pop");
    }
  };
  requestAnimationFrame(step);
}

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
  const logo = logoSrc
    ? `<span class="team-title-logo-wrap"><img class="team-title-logo" src="${logoSrc}" alt="" width="40" height="40"></span>`
    : "";
  titleEl.innerHTML = `${logo}<span>${team.name}${rosterWarning}</span>`;
  // Clicking (or tapping) the avatar replays the pop it does on arrival.
  // Keep at it — a fifth click in a row, each close behind the last — and
  // it gets angry instead: red, shaking, with 💢 popping off it.
  const logoWrap = titleEl.querySelector(".team-title-logo-wrap");
  if (logoWrap) {
    const ANGRY_CLICKS = 5;
    const CLICK_GAP_MS = 800; // a longer pause starts the count over
    const ANGRY_MS = 1800; // keep in sync with logo-angry / fx-angry in style.css
    let clicks = 0;
    let lastClick = 0;
    let angryUntil = 0;
    const img = logoWrap.firstElementChild;
    const restart = () => {
      img.style.animation = "none";
      void img.offsetWidth; // flush, so clearing it below restarts the animation
      img.style.animation = "";
    };
    logoWrap.addEventListener("click", () => {
      if (reducedMotion()) return;
      const now = performance.now();
      if (now < angryUntil) return; // mid-tantrum: let it finish
      clicks = now - lastClick > CLICK_GAP_MS ? 1 : clicks + 1;
      lastClick = now;
      if (clicks < ANGRY_CLICKS) {
        restart();
        return;
      }
      clicks = 0;
      angryUntil = now + ANGRY_MS;
      logoWrap.classList.add("angry");
      const puffs = ["avatar-fx avatar-fx-a", "avatar-fx avatar-fx-b"].map((cls) => {
        const puff = document.createElement("span");
        puff.className = cls;
        puff.setAttribute("aria-hidden", "true");
        puff.textContent = "💢";
        logoWrap.appendChild(puff);
        return puff;
      });
      restart();
      setTimeout(() => {
        logoWrap.classList.remove("angry");
        puffs.forEach((puff) => puff.remove());
        // Back to rest, without the pop it would otherwise replay on the
        // way back to its default animation.
        img.style.animation = "none";
      }, ANGRY_MS);
    });
  }
  document.title = `Tremblay Hockey Pool - ${team.name}`;
  seasonLabelEl.textContent = `${formatSeasonLabel(currentSeason)} Season`;
  backLinkEl.href = `./?season=${encodeURIComponent(currentSeason)}`;

  // The page's accents (see .has-team-color in style.css) take this team's
  // line color from the Standings chart (see getTeamColor in teams.js).
  const accent = getTeamColor(currentSeason, team.name);
  if (accent) {
    document.documentElement.style.setProperty("--team-color", accent);
    document.body.classList.add("has-team-color");
  }

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
  if (isInitialLoad) {
    // A fresh load shouldn't flash anything.
    previousPlayerStats = null;
    previousTotalScore = null;
  }
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

    // The snapshot Action can start hours late or skip a night (see the
    // note in .github/workflows/snapshot-standings.yml). When the snapshots
    // don't reach last night, work "Last Night" out from the live data
    // instead, if it has that night; otherwise the snapshots, as before.
    const night = lastNightDate();
    const useLive = !snapshotsCoverLastNight(pointsSnapshots, night)
      && roster.some((p) => p.byDate && p.byDate[night]);
    const nightIndexes = useLive
      ? { through: buildRosterIndex(rosterThrough(roster, night)), before: buildRosterIndex(rosterThrough(roster, previousDate(night))) }
      : null;
    updateLastNightHeader(pointsSnapshots, useLive ? night : null);

    // "Tonight": the current night's points so far, once its first game has
    // started and until the snapshots take it over as "Last Night".
    const tonight = tonightNight(roster, pointsSnapshots);
    const tonightIndexes = tonight
      ? { through: buildRosterIndex(rosterThrough(roster, tonight)), before: buildRosterIndex(rosterThrough(roster, previousDate(tonight))) }
      : null;

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
          : nightIndexes
            ? liveNightPoints(entry, tradeInfo, nightIndexes)
            : lastNightPoints(
              pointsSnapshots,
              (player && player.playerId) || (previousPlayer && previousPlayer.playerId) || playerIdHint(entry),
              tradeInfo
            ),
        tonight: ambiguous || !tonightIndexes ? null : liveNightPoints(entry, tradeInfo, tonightIndexes),
        injured: manuallyFlagged || Boolean(liveInjury),
        injuryLabel: liveInjury ? injuryTooltip(liveInjury) : "Injured",
      };
    });

    // Highest cost first, by each player's actual prior-season total — a
    // traded-away player keeps their place in the order even though their
    // cell shows "—". A player with no prior-season total goes last. The
    // sort is stable, so ties keep the order they're listed in teams.js.
    const costKey = (row) => (row.previousPoints == null ? -1 : row.previousPoints);
    rows.sort((a, b) => costKey(b) - costKey(a));

    const totalCost = computeTeamCost(currentSeason, team, previousRosterIndex);
    renderTeam(rows, totalCost, Boolean(tonightIndexes), isInitialLoad);
  } catch (err) {
    // A background poll failing shouldn't disrupt an already-rendered
    // page — only surface the error if this was the initial load.
    if (isInitialLoad) {
      statusEl.classList.remove("loading-pulse");
      statusEl.textContent = `Error loading team: ${err.message}`;
    }
  }
}

// teamAbbrevs lists every team a player suited up for that season, e.g.
// "TOR,VGK" — the last one is their most recent. A logo that fails to
// load just removes itself, leaving the abbreviation.
function nhlTeamLogo(teamAbbrevs) {
  const abbrev = teamAbbrevs.split(",").pop().trim();
  return `<img class="nhl-logo" src="${nhlLogoUrl(abbrev)}" alt="" width="26" height="26" onerror="this.remove()">`;
}

// `entrance` is true on the page's first render only: the rows settle in
// one after another, the numbers count up from 0, and anyone who scored
// "tonight" or "last night" gets a brief glow. (Later renders — polls, a
// theme flip — rebuild the table silently.)
function renderTeam(rows, totalCost, showTonight, entrance) {
  // Not for a tab nobody is looking at: its animations wouldn't run, and the
  // rows would sit invisible at the start of their fade until it was shown.
  const animateIn = Boolean(entrance) && !reducedMotion() && document.visibilityState === "visible";
  const glow = animateIn ? " scorer-glow" : ""; // added to the +N cells of anyone who scored
  tbody.innerHTML = "";
  let totalScore = 0, totalGoals = 0, totalAssists = 0;
  let totalLastNight = null; // stays null (shown as "—") until any row has a value
  let totalTonight = null; // same

  // The column's header is in team.html, hidden until there's a night on.
  // (Missing only if a browser pairs a cached older team.html with this
  // script right after a deploy — then there's just no column.)
  const hasTonight = showTonight && Boolean(tonightHeaderEl);
  if (tonightHeaderEl) tonightHeaderEl.hidden = !hasTonight;
  table.classList.toggle("has-tonight", hasTonight); // phone padding tweak in style.css

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

  const newPlayerStats = new Map();
  const ROW_STAGGER_MS = 30;
  // Count-ups wait until the table is on screen (end of this function):
  // they measure each number's final width first, and a table that's still
  // hidden on the page's first render has no width to measure.
  const countUps = [];

  rows.forEach(({ name, injured, injuryLabel, player, tradedOut, tradedIn, ambiguous, credited, previousPoints, previousTeam, lastNight, tonight, noDataExpected }, index) => {
    if (credited) newPlayerStats.set(name, { points: credited.points, goals: credited.goals, assists: credited.assists });
    const prev = previousPlayerStats ? previousPlayerStats.get(name) : undefined;
    const prevScore = prev ? prev.points : undefined;
    const scoreIncreased = credited && prevScore !== undefined && credited.points > prevScore;
    // Same goal lamp (red) / assist light (blue) as the Standings rows: a
    // new goal since the last poll, else it was only an assist.
    const lightClass = !scoreIncreased ? "" : credited.goals > prev.goals ? "goal-light" : "assist-light";
    const injuryTitle = (injuryLabel || "Injured").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
    const injuryIcon = injured && !tradedOut ?`<span class="injury-icon" title="${injuryTitle}">${BANDAGE_ICON}</span>` : "";
    const acquiredBadge = tradedIn
      ? `<span class="traded-badge" title="Acquired via trade — stats before joining this team don't count">Acquired</span>`
      : "";
    const tradedBadge = tradedOut
      ? `<span class="traded-badge" title="Traded away — stats locked as of the trade">Traded</span>`
      : "";
    // Always the full name as written in teams.js — consistent for every
    // row, and the spelling people know (the NHL's own can differ, e.g.
    // "Nicholas Paul", or be abbreviated in live data, e.g. "A. Barkov").
    const displayName = tradedOut ? `<span class="traded-name">${name}</span>` : name;
    // A traded-away player no longer counts toward the team's cost (see
    // computeTeamCost), so there's no number to show for them.
    const costCell = tradedOut
      ? `<td class="num" title="Traded away — not counted toward the team's cost">—</td>`
      : `<td class="num" title="Points scored the previous season">${previousPoints == null ? "—" : previousPoints}</td>`;
    if (lastNight != null) totalLastNight = (totalLastNight || 0) + lastNight;
    const lastNightCell = `<td class="num last-night${lastNight > 0 ? ` scored${glow}` : ""}">${lastNight == null ? "—" : lastNight}</td>`;
    if (tonight != null) totalTonight = (totalTonight || 0) + tonight;
    // "+N" like the Standings page's Tonight column; "—" for a player whose
    // night can't be worked out (traded away: their credit is frozen).
    const tonightCell = hasTonight
      ? `<td class="num tonight${tonight > 0 ? ` scored${glow}` : ""}">${tonight == null ? "—" : `+${tonight}`}</td>`
      : "";

    const tr = document.createElement("tr");
    if (scoreIncreased) tr.classList.add("score-flash", lightClass);
    // Traded away: no injury status (icon or bar), whether or not they're hurt.
    if (tradedOut) tr.classList.add("is-traded-out");
    else if (injured) tr.classList.add("is-injured");
    if (animateIn) {
      tr.classList.add("row-in");
      tr.style.setProperty("--i", index);
    }
    if (credited) {
      totalScore += credited.points;
      totalGoals += credited.goals;
      totalAssists += credited.assists;
      tr.innerHTML = `
        <td>${displayName}${injuryIcon}${acquiredBadge}${tradedBadge}</td>
        ${teamCell(player, previousTeam)}
        <td class="num score"><span class="score-num">${credited.points}</span></td>
        ${tonightCell}
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
        <td class="num score"><span class="score-num">0</span></td>
        ${tonightCell}
        ${lastNightCell}
        <td class="num">0</td>
        <td class="num">0</td>
        ${costCell}
      `;
    }
    tbody.appendChild(tr);

    // The page's first render counts each score up from 0, rippling down
    // the rows; a live change counts up from the score it just had.
    const scoreEl = tr.querySelector(".score-num");
    if (animateIn && credited && credited.points > 0) {
      countUps.push(() => countUp(scoreEl, 0, credited.points, { delay: 150 + index * ROW_STAGGER_MS }));
    } else if (scoreIncreased) {
      countUps.push(() => countUp(scoreEl, prevScore, credited.points, { duration: 900, pop: true }));
    }
  });
  previousPlayerStats = newPlayerStats;

  // data-count marks the totals that roll up on the first render (the
  // final value is already the cell's text; see the count below).
  tfoot.innerHTML = `
    <tr class="totals-row">
      <td colspan="2">Total</td>
      <td class="num score"><span class="score-num" data-count="${totalScore}">${totalScore.toLocaleString()}</span></td>
      ${hasTonight ? `<td class="num tonight${totalTonight > 0 ? ` scored${glow}` : ""}">${totalTonight == null ? "—" : `<span data-count="${totalTonight}" data-prefix="+">+${totalTonight.toLocaleString()}</span>`}</td>` : ""}
      <td class="num last-night${totalLastNight > 0 ? ` scored${glow}` : ""}">${totalLastNight == null ? "—" : `<span data-count="${totalLastNight}">${totalLastNight.toLocaleString()}</span>`}</td>
      <td class="num"><span data-count="${totalGoals}">${totalGoals.toLocaleString()}</span></td>
      <td class="num"><span data-count="${totalAssists}">${totalAssists.toLocaleString()}</span></td>
      <td class="num"><span data-count="${totalCost}">${totalCost.toLocaleString()}</span></td>
    </tr>
  `;
  const totalsRow = tfoot.querySelector(".totals-row");
  if (animateIn) {
    totalsRow.classList.add("row-in");
    totalsRow.style.setProperty("--i", rows.length);
    const delay = 150 + rows.length * ROW_STAGGER_MS;
    totalsRow.querySelectorAll("[data-count]").forEach((el) => {
      const to = Number(el.dataset.count);
      if (to > 0) {
        countUps.push(() => countUp(el, 0, to, { delay, duration: 900, prefix: el.dataset.prefix || "", pop: el.classList.contains("score-num") }));
      }
    });
  } else if (previousTotalScore !== null && totalScore > previousTotalScore) {
    const totalEl = totalsRow.querySelector(".score-num");
    const fromTotal = previousTotalScore; // (updated just below, before this runs)
    countUps.push(() => countUp(totalEl, fromTotal, totalScore, { duration: 900, pop: true }));
  }
  previousTotalScore = totalScore;

  statusEl.hidden = true;
  table.hidden = false;
  countUps.forEach((start) => start());
}

init();
