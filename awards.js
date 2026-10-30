// Weekly awards: the Awards page, which lists a few awards for each finished
// week (Sunday to Saturday — the Sunday-morning snapshot closes
// a week), with arrows to browse earlier weeks.
//
// The awards are worked out once, when the week ends, by
// .github/scripts/snapshot-standings.mjs (which calls buildWeeklyAwards below
// in the live page) and saved to data/weekly-awards.json — so a past week's
// awards never change afterwards, whatever happens to rosters or the injury
// report. The card just reads that file.

const AWARDS_URL = "data/weekly-awards.json";
const AWARD_DAY_MS = 24 * 60 * 60 * 1000;

function addDays(dateStr, days) {
  return new Date(Date.parse(dateStr) + days * AWARD_DAY_MS).toISOString().slice(0, 10);
}

// ---- Working the awards out ------------------------------------------------

const awardTotalsCache = new Map(); // "season|date" -> Promise<Map<playerId, stat line>>

// Every skater's season totals before `date` (the stats API's `before`
// filter), by playerId. A past date's totals never change, so they're kept.
function fetchAwardTotals(season, date) {
  const key = `${season}|${date}`;
  if (!awardTotalsCache.has(key)) {
    const params = new URLSearchParams({ season, limit: -1, start: 0, sort: "player", dir: "ASC", before: date });
    const request = fetch(`${API_BASE}/api/players?${params}`)
      .then((r) => r.json())
      .then(({ players }) => new Map(players.map((p) => [p.playerId, {
        points: p.points, goals: p.goals, assists: p.assists, gamesPlayed: p.gamesPlayed,
      }])));
    awardTotalsCache.set(key, request);
    request.catch(() => awardTotalsCache.delete(key)); // a failure isn't remembered
  }
  return awardTotalsCache.get(key);
}

// Sorts `items` best-first by `compare` (negative when a is better) and
// splits off everyone who ties for the top — a tie shares the award.
function pickBest(items, compare) {
  const sorted = items.slice().sort(compare);
  if (!sorted.length) return null;
  const winners = sorted.filter((item) => compare(item, sorted[0]) === 0);
  return { winners, rest: sorted.slice(winners.length) };
}

// "Standard competition" ranks ("1, 1, 3…") for a standings array, by team.
function awardRanks(standings) {
  const sorted = standings.slice().sort((a, b) => b.score - a.score);
  const ranks = new Map();
  sorted.forEach((s, i) => ranks.set(s.team, i > 0 && s.score === sorted[i - 1].score ? ranks.get(sorted[i - 1].team) : i + 1));
  return ranks;
}

// The first couple of distinct players below the winners, as { player, team,
// points }. (A player on several pool teams is listed once.)
function nextPlayers(rest, valueOf, count = 2) {
  const seen = new Set();
  const out = [];
  rest.forEach((row) => {
    if (out.length >= count || seen.has(row.player)) return;
    seen.add(row.player);
    out.push({ player: row.player, team: row.team, value: valueOf(row) });
  });
  return out;
}

// How a player stands on a team at the end of a week: "active", "gone"
// (already traded away) or "notYet" (only acquired later) — so a past week is
// judged on the roster the team had then, not today's. A trade with no date
// is taken as already made.
function awardRosterState(season, teamName, name, weekEnd) {
  let state = "active";
  getTradesForSeason(season).forEach((trade) => {
    if (trade.team !== teamName) return;
    const when = trade.date || "0000-00-00";
    if (trade.playerOut.name === name && when <= weekEnd) state = "gone";
    if (trade.playerIn.name === name && when > weekEnd) state = "notYet";
  });
  return state;
}

// The awards for the week ending `weekEnd` (a Saturday), as the object saved
// in data/weekly-awards.json. `previous` and `current` are the standings
// snapshots ([{ team, score }]) at the end of the week before and of this
// one; `previous` is null in the first week. Options:
//   - injuries: also hand out Trainer's Room. `true` reads today's injury
//     report (right only when this is run as the week ends); a Map of
//     normalized player name -> anything uses that report instead (see
//     data/injury-history.json). Left off, the award is left out;
//   - firstDate: the season's first snapshot date, to number the weeks.
// An award nobody qualifies for is left out.
async function buildWeeklyAwards(season, weekEnd, previous, current, { injuries = false, firstDate = null } = {}) {
  const weekStart = addDays(weekEnd, -6);
  const [roster, previousRoster, startTotals, endTotals, injuryReport] = await Promise.all([
    fetchAllPlayersForSeason(season),
    fetchAllPlayersForSeason(previousSeasonId(season)).catch(() => []),
    fetchAwardTotals(season, weekStart),
    fetchAwardTotals(season, addDays(weekEnd, 1)),
    injuries === true ? fetchInjuries() : null,
  ]);
  const report = injuries instanceof Map ? injuries : injuryReport;
  const rosterIndex = buildRosterIndex(roster);
  const previousIndex = buildRosterIndex(previousRoster);
  const none = { points: 0, goals: 0, assists: 0, gamesPlayed: 0 };
  const awards = {};

  // -- Team awards, from the standings at each end of the week.
  const before = new Map((previous || []).map((s) => [s.team, s.score]));
  const teamPoints = current.map((s) => ({ team: s.team, points: s.score - (before.get(s.team) || 0) }));
  const best = pickBest(teamPoints, (a, b) => b.points - a.points);
  if (best && best.winners[0].points > 0) {
    awards.teamOfWeek = {
      teams: best.winners.map((w) => w.team),
      points: best.winners[0].points,
      next: best.rest.slice(0, 2).map((r) => ({ team: r.team, points: r.points })),
    };
  }

  if (previous) {
    const [then, now] = [awardRanks(previous), awardRanks(current)];
    const movers = current.map((s) => ({
      team: s.team, from: then.get(s.team), to: now.get(s.team), gain: then.get(s.team) - now.get(s.team),
      points: teamPoints.find((t) => t.team === s.team).points,
    }));
    const biggest = pickBest(movers, (a, b) => b.gain - a.gain || b.points - a.points);
    if (biggest && biggest.winners[0].gain > 0) {
      awards.biggestMover = {
        gain: biggest.winners[0].gain,
        teams: biggest.winners.map((w) => ({ team: w.team, from: w.from, to: w.to })),
      };
    }
  }

  // -- Player awards: each active player on each team, with what they scored
  // this week for that team (a player acquired in a trade counts from the
  // trade on, the same as the standings), and their cost (last season's points).
  const rows = [];
  getTeamsForSeason(season).forEach((team) => {
    team.players.forEach((entry) => {
      const name = playerName(entry);
      const tradeInfo = getTradeInfo(season, team.name, name);
      if (awardRosterState(season, team.name, name, weekEnd) !== "active") return;
      const { player, ambiguous } = resolvePlayer(rosterIndex, name, playerTeamHint(entry), playerPositionHint(entry), playerIdHint(entry));
      if (ambiguous || !player) return;
      const start = startTotals.get(player.playerId) || none;
      const end = endTotals.get(player.playerId) || none;
      const prior = resolvePlayer(previousIndex, name, null, playerPositionHint(entry), playerIdHint(entry));
      rows.push({
        player: name,
        team: team.name,
        points: Math.max(0, end.points - Math.max(start.points, tradeInfo.entry.points)),
        goals: Math.max(0, end.goals - Math.max(start.goals, tradeInfo.entry.goals)),
        games: end.gamesPlayed - start.gamesPlayed,
        cost: !prior.ambiguous && prior.player ? prior.player.points : 0,
      });
    });
  });

  const star = pickBest(rows, (a, b) => b.points - a.points || b.goals - a.goals);
  if (star && star.winners[0].points > 0) {
    const top = star.winners[0];
    awards.playerOfWeek = {
      winners: star.winners.map((w) => ({ player: w.player, team: w.team })),
      points: top.points,
      goals: top.goals,
      assists: top.points - top.goals,
      next: nextPlayers(star.rest, (r) => r.points),
    };
  }

  // Points per point of cost: highest is the bargain, lowest (among the
  // pricey players who actually played) the anchor.
  const bargain = pickBest(rows.filter((r) => r.points >= 3),
    (a, b) => b.points / Math.max(b.cost, 1) - a.points / Math.max(a.cost, 1) || b.points - a.points);
  if (bargain) {
    const top = bargain.winners[0];
    awards.bargainBin = {
      winners: bargain.winners.map((w) => ({ player: w.player, team: w.team })),
      points: top.points,
      cost: top.cost,
      next: nextPlayers(bargain.rest, (r) => r.points),
    };
  }
  const anchor = pickBest(rows.filter((r) => r.cost >= 50 && r.games >= 2),
    (a, b) => a.points / a.cost - b.points / b.cost || b.cost - a.cost);
  if (anchor) {
    const top = anchor.winners[0];
    awards.capAnchor = {
      winners: anchor.winners.map((w) => ({ player: w.player, team: w.team })),
      points: top.points,
      cost: top.cost,
      games: top.games,
    };
  }

  // -- Trade of the week: of the week's trades, the one where the player who
  // came in out-scored the one who left (since the trade) by the most.
  const trades = getTradesForSeason(season)
    .filter((t) => t.date && t.date >= weekStart && t.date <= weekEnd)
    .map((trade) => {
      const incoming = resolvePlayer(rosterIndex, trade.playerIn.name, null, null, null);
      const outgoing = resolvePlayer(rosterIndex, trade.playerOut.name, null, null, null);
      if (incoming.ambiguous || !incoming.player || outgoing.ambiguous || !outgoing.player) return null;
      const pointsIn = Math.max(0, (endTotals.get(incoming.player.playerId) || none).points - trade.playerIn.points);
      const pointsOut = Math.max(0, (endTotals.get(outgoing.player.playerId) || none).points - trade.playerOut.points);
      return { team: trade.team, date: trade.date, playerIn: trade.playerIn.name, playerOut: trade.playerOut.name, pointsIn, pointsOut };
    })
    .filter(Boolean);
  const bestTrade = pickBest(trades, (a, b) => (b.pointsIn - b.pointsOut) - (a.pointsIn - a.pointsOut));
  if (bestTrade && bestTrade.winners[0].pointsIn > bestTrade.winners[0].pointsOut) {
    awards.tradeOfWeek = bestTrade.winners[0];
  }

  // -- Trainer's Room: the team with the most injured players on its roster.
  if (report) {
    const hurt = getTeamsForSeason(season).map((team) => ({
      team: team.name,
      players: team.players
        .map(playerName)
        .filter((name) => awardRosterState(season, team.name, name, weekEnd) === "active" && report.has(normalizePlayerName(name))),
    }));
    const worst = pickBest(hurt, (a, b) => b.players.length - a.players.length);
    if (worst && worst.winners[0].players.length > 0) {
      awards.trainersRoom = {
        teams: worst.winners.map((w) => w.team),
        count: worst.winners[0].players.length,
        players: worst.winners.length === 1 ? worst.winners[0].players : [],
      };
    }
  }

  const week = firstDate ? Math.floor((Date.parse(weekEnd) - Date.parse(firstDate)) / (7 * AWARD_DAY_MS)) + 1 : null;
  return { week, weekStart, weekEnd, awards };
}

// ---- The card --------------------------------------------------------------

const awardsEl = document.getElementById("awards");
const awardsStatusEl = document.getElementById("status");
let awardsWeeks = [];
let awardsIndex = 0;
let awardsSeason = null;

const awardsEsc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function awardsDay(dateStr) {
  return new Date(`${dateStr}T12:00:00Z`).toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" });
}

function awardsOrdinal(n) {
  const mod = n % 100;
  if (mod >= 11 && mod <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] || "th"}`;
}

// A pool team's logo as a small round avatar, or its first letter.
function awardTeamIcon(teamName) {
  const logo = getTeamLogo(awardsSeason, teamName);
  const label = awardsEsc(teamName);
  return logo
    ? `<img class="aw-icon" src="${logo}" alt="${label}" title="${label}" width="40" height="40">`
    : `<span class="aw-icon aw-fallback" title="${label}">${awardsEsc(teamName.charAt(0))}</span>`;
}

// Winners of a team award: each one's icon and name ("Rick & Curtis" on a tie).
function awardTeamsHtml(teams) {
  return teams.map((t) => `${awardTeamIcon(t)}<span>${awardsEsc(t)}</span>`).join('<span class="aw-amp">&amp;</span>');
}

// Winners of a player award: the player's name, with an icon for each team
// that owns them (a player on several teams is shown once).
function awardPlayersHtml(winners) {
  const byPlayer = new Map();
  winners.forEach((w) => byPlayer.set(w.player, [...(byPlayer.get(w.player) || []), w.team]));
  return [...byPlayer].map(([player, teams]) =>
    `<span class="aw-name">${awardsEsc(player)}</span><span class="aw-owners">${teams.map(awardTeamIcon).join("")}</span>`).join('<span class="aw-amp">&amp;</span>');
}

// "Then Hughes 7, Rantanen 7" under a player award.
function awardPlayersContext(next) {
  return next.length ? `Then ${next.map((n) => `${awardsEsc(n.player)} ${n.value} ${n.value === 1 ? "pt" : "pts"}`).join(", ")}` : "";
}

// The tiles' icons: Tabler Icons' outline set (MIT), as the paths inside a
// 24x24 stroked SVG.
const AWARD_ICONS = {
  trophy: '<path d="M8 21h8M12 17v4M7 4h10M17 4v8a5 5 0 0 1-10 0V4"/><circle cx="5" cy="9" r="2"/><circle cx="19" cy="9" r="2"/>',
  trend: '<path d="M3 17l6-6 4 4 8-8M14 7h7v7"/>',
  star: '<path d="M12 17.75l-6.172 3.245 1.179-6.873-5-4.867 6.9-1 3.086-6.253 3.086 6.253 6.9 1-5 4.867 1.179 6.873z"/>',
  tag: '<circle cx="7.5" cy="7.5" r="1"/><path d="M3 6v5.172a2 2 0 0 0 .586 1.414l7.71 7.71a2.41 2.41 0 0 0 3.408 0l5.592-5.592a2.41 2.41 0 0 0 0-3.408l-7.71-7.71A2 2 0 0 0 11.172 3H6a3 3 0 0 0-3 3z"/>',
  anchor: '<path d="M12 9v12m-8-8a8 8 0 0 0 16 0m1 0h-2m-14 0H3"/><circle cx="12" cy="6" r="3"/>',
  exchange: '<path d="M7 10h14l-4-4M17 14H3l4 4"/>',
  kit: '<path d="M8 8V6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M10 14h4M12 12v4"/>',
};

function awardIcon(name) {
  return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${AWARD_ICONS[name]}</svg>`;
}

// Each award's tile: [key in the saved week, icon, title, how to fill it in].
// A fill returns { winner, big, context } as HTML.
const AWARD_TILES = [
  ["teamOfWeek", "trophy", "Team of the week", (a) => ({
    winner: awardTeamsHtml(a.teams),
    big: `<em>+${a.points}</em> points this week`,
    context: a.next.length ? `Then ${a.next.map((n) => `${awardsEsc(n.team)} +${n.points}`).join(", ")}` : "",
  })],
  ["biggestMover", "trend", "Biggest mover", (a) => ({
    winner: awardTeamsHtml(a.teams.map((t) => t.team)),
    big: a.teams.length === 1
      ? `<em>&#9650;${a.gain}</em> ${a.gain === 1 ? "spot" : "spots"}, ${awardsOrdinal(a.teams[0].from)} to ${awardsOrdinal(a.teams[0].to)}`
      : `<em>&#9650;${a.gain}</em> ${a.gain === 1 ? "spot" : "spots"} each`,
    context: "",
  })],
  ["playerOfWeek", "star", "Player of the week", (a) => ({
    winner: awardPlayersHtml(a.winners),
    big: `<em>${a.points}</em> ${a.points === 1 ? "pt" : "pts"} &middot; ${a.goals} G, ${a.assists} A`,
    context: awardPlayersContext(a.next),
  })],
  ["bargainBin", "tag", "Bargain bin", (a) => ({
    winner: awardPlayersHtml(a.winners),
    big: `<em>${a.points}</em> pts on a cost of ${a.cost}`,
    context: awardPlayersContext(a.next),
  })],
  ["capAnchor", "anchor", "Cap anchor", (a) => ({
    winner: awardPlayersHtml(a.winners),
    big: `<em>${a.points}</em> ${a.points === 1 ? "pt" : "pts"} on a cost of ${a.cost}`,
    context: `In ${a.games} games`,
  })],
  ["tradeOfWeek", "exchange", "Trade of the week", (a) => ({
    winner: awardTeamsHtml([a.team]),
    big: `${awardsEsc(a.playerIn)} <em>${a.pointsIn}</em> ${a.pointsIn === 1 ? "pt" : "pts"} vs ${awardsEsc(a.playerOut)} ${a.pointsOut}`,
    context: `Since the trade on ${awardsDay(a.date)}`,
  })],
  ["trainersRoom", "kit", "Trainer's room", (a) => ({
    winner: awardTeamsHtml(a.teams),
    big: `<em>${a.count}</em> ${a.count === 1 ? "player" : "players"} injured${a.teams.length > 1 ? " each" : ""}`,
    context: a.players.map(awardsEsc).join(", "),
  })],
];

function renderAwards() {
  awardsStatusEl.classList.remove("loading-pulse");
  awardsStatusEl.hidden = awardsWeeks.length > 0;
  if (!awardsWeeks.length) {
    awardsStatusEl.textContent = "No awards yet — the first set is handed out the Sunday morning after a week ends.";
    awardsEl.hidden = true;
    return;
  }
  const entry = awardsWeeks[awardsIndex];
  const tiles = AWARD_TILES.filter(([key]) => entry.awards[key]).map(([key, icon, title, fill]) => {
    const { winner, big, context } = fill(entry.awards[key]);
    return `
      <div class="aw-tile">
        <div class="aw-kind">${awardIcon(icon)}${title}</div>
        <div class="aw-winner">${winner}</div>
        <div class="aw-big">${big}</div>
        ${context ? `<div class="aw-context">${context}</div>` : ""}
      </div>`;
  }).join("");

  const range = `${awardsDay(entry.weekStart)} – ${awardsDay(entry.weekEnd)}`;
  const last = awardsWeeks.length - 1;
  const chips = awardsWeeks.map((w, i) => `
      <button type="button" class="aw-chip${i === awardsIndex ? " is-active" : ""}" data-index="${i}"
        aria-label="Week ${w.week || i + 1}"${i === awardsIndex ? ' aria-current="true"' : ""}>${w.week || i + 1}</button>`).join("");
  awardsEl.innerHTML = `
    <div class="aw-head">
      <button type="button" id="aw-prev" aria-label="Previous week"${awardsIndex === 0 ? " disabled" : ""}>&#8249;</button>
      <div class="aw-title"><h2>${entry.week ? `Week ${entry.week}` : "Awards"}</h2><span>${range}</span></div>
      <button type="button" id="aw-next" aria-label="Next week"${awardsIndex === last ? " disabled" : ""}>&#8250;</button>
    </div>
    <div class="aw-weeks" role="group" aria-label="Weeks">${chips}</div>
    <div class="aw-grid">${tiles || '<p class="aw-empty">No awards for this week.</p>'}</div>
    <p class="aw-foot">Awards cover Sunday to Saturday and are handed out on Sunday morning. Ties share the award.</p>`;
  awardsEl.hidden = false;
}

awardsEl.addEventListener("click", (event) => {
  const button = event.target.closest("#aw-prev, #aw-next, .aw-chip");
  if (!button || button.disabled) return;
  awardsIndex = button.classList.contains("aw-chip")
    ? Number(button.dataset.index)
    : Math.min(awardsWeeks.length - 1, Math.max(0, awardsIndex + (button.id === "aw-next" ? 1 : -1)));
  renderAwards();
});
// Re-draw on a theme flip so the team logos match the new theme.
window.addEventListener("themechange", renderAwards);

async function initAwards() {
  const seasons = getPoolSeasons();
  awardsSeason = seasons[seasons.length - 1];
  const data = await fetch(AWARDS_URL).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  awardsWeeks = (data[awardsSeason] || []).slice().sort((a, b) => a.weekEnd.localeCompare(b.weekEnd));
  awardsIndex = awardsWeeks.length - 1;
  renderAwards();
}

initAwards();
