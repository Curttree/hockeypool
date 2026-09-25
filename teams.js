// Pool data, keyed by season since a fresh draft happens every year.
// Each season is { teams, trades }:
//
// - teams: a given season's array only lists the teams that played that
//   year, so a team can be added or removed just by including/omitting
//   it. Team names stay stable across years for teams that continue
//   (they're the lookup key used by team.html's links). Each team has a
//   display name, an optional `logo` (path to an image, used as the
//   marker on that team's most recent point in the "Standings Over
//   Time" chart — falls back to a plain dot if omitted), and a list of
//   players. A player entry is either a
//   plain full-name string, or an object { name, injured, team, position }
//   — all fields but `name` optional:
//     - injured: true force-flags them as injured (see below).
//     - team / position (e.g. "VAN" / "C"): only needed if this name is
//       shared by more than one player in the league — the app detects
//       that automatically (see common.js's resolvePlayer) and shows a
//       warning naming the conflict, so you'll know to add one or both
//       of these to pick the right player.
//
// - trades: mid-season roster moves. A trade never removes anyone from
//   a team's `players` list — the player traded away stays listed (see
//   getTradeInfo below), and the player traded in gets appended. Each
//   entry is one team's side of a trade:
//     {
//       team,
//       playerOut: { name, points, goals, assists },
//       playerIn: { name, points, goals, assists },
//     }
//   All three numbers are the named player's *actual* season totals at
//   the moment of the trade, entered by hand (there's no API for this) —
//   and should satisfy points = goals + assists, same as any real stat
//   line, so a traded player's displayed G + A still sums to their
//   Score. playerOut's numbers become that player's final, frozen
//   credit to this team. playerIn's numbers get subtracted from their
//   real season totals, crediting the team only for what they did after
//   the trade. A player can be traded more than once (in and later out
//   again) — each team's credit for them is always (exit snapshot if
//   later traded away, else live totals) minus (entry snapshot if
//   acquired via trade, else zero), applied to points/goals/assists
//   alike, so chained trades resolve without special-casing.
//   Cap: two trades per team per season — not enforced in code, same
//   as nobody checking rosters are exactly 20 players; just a rule to
//   follow when editing this file.
//
// - seasonEnd (optional, on the season object alongside `teams`/`trades`):
//   a "YYYY-MM-DD" date used only by the "Standings Over Time" chart's
//   season-end projection option. Omit it and it defaults to April 15
//   of the season's second year — a reasonable stand-in for when an
//   NHL regular season wraps up — so you only need to set this if that
//   guess is off for a given year.
//
// Injury status is normally detected automatically on the team detail
// page (see common.js's fetchInjuries, sourced from ESPN's public
// feed since the NHL's own API has no injury data). The manual
// `injured: true` flag is just a fallback/override for cases the feed
// misses — you shouldn't need to set it by hand under normal use.
//
// Names must match the NHL API's "skaterFullName" spelling exactly,
// e.g. "Tim Stützle".
//
// Add a new season by adding another key here; nothing else in the code
// needs to change.
const TEAMS_BY_SEASON = {
  "20262027": {
    teams:
    [
    {
        name: "Curtis",
        logo: "images/curtis.svg",
        players: ["Macklin Celebrini", "David Pastrnak", "Leon Draisaitl", "William Nylander", "Jack Hughes", "Mikko Rantanen",
          "Matthew Schaefer", "Brady Tkachuk", "Will Smith", "Auston Matthews", "Zach Hyman", "Mason McTavish", "Matthew Tkachuk",
          "Easton Cowan", "Pierre-Luc Dubois", "Nick Paul", "Porter Martone", "Anton Frondell", "Zayne Parekh", "William Karlsson"
        ]
    },
    {
        name: "Anmol",
        logo: "images/anmol.svg",
        players: ["Nick Suzuki", "Kyle Connor", "Jake Guentzel", "Mitch Marner", "Jack Hughes", "Connor Bedard", "Gabriel Vilardi",
          "Seth Jarvis", "Ivan Demidov", "Auston Matthews", "Zach Hyman", "Nazem Kadri", "Brayden Point", "Jake Neighbours",
          "Zachary Bolduc", "Blake Lizotte", "Tristan Broz", "Rafael Harvey-Pinard", "Dylan Duke", "Carson Lambos"
        ]
    },
    {
        name: "Jordan",
        logo: "images/jordan.svg",
        players: ["Connor McDavid", "David Pastrnak", "Leon Draisaitl", "Connor Bedard", "Gabriel Vilardi", "Brock Nelson", "Bryan Rust",
          "Will Cuylle", "Travis Sanheim", "Dmitry Orlov", "K'Andre Miller", "Jack Roslovic", "Sean Monahan", "Brent Burns",
          "Gabriel Landeskog", "Philip Broberg", "Berkly Catton", "Oskar Sundqvist", "Wyatt Kaiser", "Kirby Dach"
        ]
    },
    {
        name: "Hannah",
        logo: "images/hannah.svg",
        players: ["Nathan MacKinnon","Evan Bouchard", "William Nylander", "Jack Hughes", "Sidney Crosby", "Mark Stone", "Dylan Larkin",
          "Ivan Barbashev", "Auston Matthews", "J.T. Miller", "Vladimir Tarasenko", "Boone Jenner", "Michael Amadio", "Andre Burakovsky",
          "Jake Evans", "Nick Cousins", "Tyler Seguin", "Barclay Goodrow", "William Karlsson", "Nils Hoglander"
        ]
    },
    {
        name: "Gayle",
        logo: "images/gayle.svg",
        players: ["Connor McDavid", "Nathan MacKinnon", "William Nylander", "Mika Zibanejad", "Filip Forsberg", "Juraj Slafkovský",
          "Nikolaj Ehlers", "Andrei Svechnikov", "Kirill Marchenko", "Miro Heiskanen", "Mikhail Sergachev", "Shayne Gostisbehere", "Oskar Sundqvist",
          "Uvis Balinskis", "Juuso Parssinen", "Jonah Gadjovich", "Vladislav Kolyachonok", "Ivan Miroshnichenko", "Maksim Tsyplakov",
          "Kirill Kudryavtsev"
        ]
    }
    ],
    trades: [],
    seasonEnd: "2027-04-10",
  }
};

function getPoolSeasons() {
  return Object.keys(TEAMS_BY_SEASON).sort();
}

function getTeamsForSeason(season) {
  return (TEAMS_BY_SEASON[season] && TEAMS_BY_SEASON[season].teams) || [];
}

function getTradesForSeason(season) {
  return (TEAMS_BY_SEASON[season] && TEAMS_BY_SEASON[season].trades) || [];
}

function findTeamByName(season, name) {
  return getTeamsForSeason(season).find((t) => t.name === name);
}

// Path to a team's logo image, or null if it doesn't have one — used to
// mark the most recent point on that team's line in the history chart.
function getTeamLogo(season, name) {
  const team = findTeamByName(season, name);
  return (team && team.logo) || null;
}

// A season's end date, for the history chart's season-end projection
// option. Falls back to April 15 of the season's second year if not
// configured explicitly (see the schema comment above).
function getSeasonEnd(season) {
  const configured = TEAMS_BY_SEASON[season] && TEAMS_BY_SEASON[season].seasonEnd;
  if (configured) return configured;
  const endYear = season.slice(4);
  return `${endYear}-04-15`;
}

// "20262027" -> "20252026" — used to look up each player's prior-season
// point total for a team's "Cost" (see computeTeamCost below).
function previousSeasonId(season) {
  const start = parseInt(season.slice(0, 4), 10) - 1;
  const end = parseInt(season.slice(4), 10) - 1;
  return `${start}${end}`;
}

// Sums a team's "Cost": each player's prior-season point total, minus
// (rather than plus) anyone traded away, since they're no longer really
// part of the roster going forward. `previousRosterIndex` is the prior
// season's roster (buildRosterIndex) — fetch and build it once per
// season and reuse it across every team, rather than per team.
function computeTeamCost(season, team, previousRosterIndex) {
  let totalCost = 0;
  team.players.forEach((entry) => {
    const name = playerName(entry);
    const tradedOut = getTradeInfo(season, team.name, name).tradedOut;
    // Team hint is dropped — a player's team last season may well
    // differ from the (current-season) hint in teams.js.
    const resolved = resolvePlayer(previousRosterIndex, name, null, playerPositionHint(entry));
    const previousPoints = !resolved.ambiguous && resolved.player ? resolved.player.points : null;
    if (previousPoints != null) totalCost += tradedOut ? -previousPoints : previousPoints;
  });
  return totalCost;
}

// True if the player appears in the given roster index at all (a name
// shared by several players still counts — they clearly exist). Team
// hint is dropped since a player's team can change between seasons.
//
// Used against *last* season's roster as the "does this player really
// exist" check: a player with no current-season stats yet (season not
// started, or just hasn't played) only warrants a warning if they
// weren't in last season's list either. Anyone who's since left the
// league is expected to be flagged by hand.
function existsInRoster(rosterIndex, entry) {
  const r = resolvePlayer(rosterIndex, playerName(entry), null, playerPositionHint(entry));
  return r.ambiguous || Boolean(r.player);
}

// A pool roster should have exactly this many currently-active players —
// a traded-away player still lives in `players` (see getTradeInfo) but
// no longer counts toward this, since they're not really on the team.
const EXPECTED_ROSTER_SIZE = 20;

// Counts a team's currently-active players: everyone in `players` except
// anyone traded away — still listed for scoring continuity, but no
// longer really part of the roster going forward.
function countActivePlayers(season, team) {
  return team.players.filter((entry) => {
    const name = playerName(entry);
    return !getTradeInfo(season, team.name, name).tradedOut;
  }).length;
}

function playerName(entry) {
  return typeof entry === "string" ? entry : entry.name;
}

function playerIsInjured(entry) {
  return typeof entry === "object" && entry.injured === true;
}

function playerTeamHint(entry) {
  return (typeof entry === "object" && entry.team) || null;
}

function playerPositionHint(entry) {
  return (typeof entry === "object" && entry.position) || null;
}

const EMPTY_STAT_LINE = { points: 0, goals: 0, assists: 0 };

// Resolves a player's trade history for one team: the stat line to
// subtract if they were acquired via trade (entry, zeroed otherwise),
// and their frozen final stat line if they were later traded away
// (exit, null if still active). If a player appears in more than one
// matching trade for this team, the last one in the list wins.
function getTradeInfo(season, teamName, playerName) {
  let entry = EMPTY_STAT_LINE;
  let exit = null;
  let tradedIn = false;

  getTradesForSeason(season).forEach((trade) => {
    if (trade.team !== teamName) return;
    if (trade.playerIn && trade.playerIn.name === playerName) {
      const { points, goals, assists } = trade.playerIn;
      entry = { points, goals, assists };
      tradedIn = true;
    }
    if (trade.playerOut && trade.playerOut.name === playerName) {
      const { points, goals, assists } = trade.playerOut;
      exit = { points, goals, assists };
    }
  });

  return { entry, exit, tradedIn, tradedOut: exit !== null };
}

// Applies a getTradeInfo() result to a player's live stat line
// ({ points, goals, assists }, or null if not found in the current
// roster fetch), returning what should actually be credited to this
// team — or null if there's nothing to credit them with at all (not
// traded away, and no live stats found).
function creditedStats(tradeInfo, live) {
  const base = tradeInfo.exit || live;
  if (!base) return null;
  return {
    points: base.points - tradeInfo.entry.points,
    goals: base.goals - tradeInfo.entry.goals,
    assists: base.assists - tradeInfo.entry.assists,
  };
}
