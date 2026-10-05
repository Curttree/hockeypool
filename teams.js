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
//   plain full-name string, or an object { name, injured, team, position, id }
//   — all fields but `name` optional:
//     - injured: true force-flags them as injured (see below).
//     - team / position (e.g. "VAN" / "C"): only needed if this name is
//       shared by more than one player in the league — the app detects
//       that automatically (see common.js's resolvePlayer) and shows a
//       warning naming the conflict, so you'll know to add one or both
//       of these to pick the right player.
//     - id: the player's NHL playerId (e.g. 8477426 — it's in the
//       player's nhl.com URL). Pins the exact player, so they still
//       resolve if the NHL's spelling of their name differs from `name`
//       (e.g. it lists "Nicholas Paul"). `name` is still what's shown
//       and matched against injury reports and trades, so keep it as
//       the name people know them by.
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
        logo: "images/curtis.png",
        players: ["Macklin Celebrini", "David Pastrnak", "Leon Draisaitl", "William Nylander", "Jack Hughes", "Mikko Rantanen",
          "Kirill Marchenko", "Brady Tkachuk", "Will Smith", "Auston Matthews", "Zach Hyman", "Mason McTavish", "Matthew Tkachuk",
          "Michael Misa", "Pierre-Luc Dubois", { name: "Nick Paul", id: 8477426 }, "Porter Martone", "Anton Frondell", "Zayne Parekh", "William Karlsson"
        ]
    },
    {
        name: "Anmol",
        logo: "images/anmol.png",
        players: ["Nick Suzuki", "Kyle Connor", "Jake Guentzel", "Mitch Marner", "Jack Hughes", "Connor Bedard", "Gabriel Vilardi",
          "Kirill Marchenko", "Ivan Demidov", "Auston Matthews", "Zach Hyman", "Nazem Kadri", "Brayden Point", "Jake Neighbours",
          "Zachary Bolduc", "Tyler Seguin", "Michael Brandsegg-Nygård", "Rafael Harvey-Pinard", "Dylan Duke", "Carson Lambos"
        ]
    },
    {
        name: "Jordan",
        logo: "images/jordan.png",
        players: ["Connor McDavid", "David Pastrnak", "Leon Draisaitl", "Connor Bedard", "Gabriel Vilardi", "Brock Nelson", "Bryan Rust",
          "Will Cuylle", "Travis Sanheim", "Dmitry Orlov", "K'Andre Miller", "Jack Roslovic", "Sean Monahan", "Brent Burns",
          "Gabriel Landeskog", "Philip Broberg", "Berkly Catton", "Oskar Sundqvist", "Wyatt Kaiser", "Kirby Dach"
        ]
    },
    {
        name: "Hannah",
        logo: "images/hannah.png",
        players: ["Nathan MacKinnon","Evan Bouchard", "William Nylander", "Jack Hughes", "Sidney Crosby", "Mark Stone", "Leo Carlsson",
          "Ivan Barbashev", "Auston Matthews", "J.T. Miller", "Vladimir Tarasenko", "Boone Jenner", "Michael Amadio", "Andre Burakovsky",
          "Jake Evans", "Nick Cousins", "Tyler Seguin", "Barclay Goodrow", "William Karlsson", "Nils Hoglander"
        ]
    },
    {
        name: "Gayle",
        logo: "images/gayle.png",
        players: ["Connor McDavid", "Nathan MacKinnon", "William Nylander", "Mika Zibanejad", "Filip Forsberg", "Juraj Slafkovský",
          "Nikolaj Ehlers", "Andrei Svechnikov", "Kirill Marchenko", "Miro Heiskanen", "Mikhail Sergachev", "Shayne Gostisbehere", "Oskar Sundqvist",
          "Uvis Balinskis", "Juuso Parssinen", "Dominik Shine", "Vladislav Kolyachonok", "Ivan Miroshnichenko", "Maksim Tsyplakov",
          "Kirill Kudryavtsev"
        ]
    },
    {
        name: "Luke",
        logo: "images/luke.png",
        players:["Connor McDavid", "Nikita Kucherov", "Nathan MacKinnon", "Connor Bedard", "Sidney Crosby", "Alex Ovechkin", "Brad Marchand",
        "Luke Hughes", "Marco Rossi", "Ridly Greig", "Justin Brazeau", "Cole Perfetti", "Bobby Brink", "David Perron",
        "Jaden Schwartz", "Jonatan Berggren", "Matvei Gridin", "Pierre-Luc Dubois", "Ryan Ufko", "Porter Martone"]
    },
    {
        name: "Rick",
        logo: "images/rick.png",
        players:["Leon Draisaitl", "Kirill Kaprizov", "William Nylander", "Jack Hughes", "Mikko Rantanen", "Robert Thomas", "Sam Reinhart", "Brady Tkachuk", "Auston Matthews",
        "Zach Hyman", "Jimmy Snuggerud", "Brayden Point", "Jordan Kyrou", "Matthew Tkachuk", "Josh Norris", "Gabe Perreault", "Pierre-Luc Dubois",
        "Tyler Seguin", "Porter Martone", "Ilya Protas"]
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

// Each pool team's accent color: its line on the "Standings Over Time"
// chart, and the divider on its team page. Assigned by the team's position
// in the season's team list — not its position in whatever data the chart
// is showing, which shifts with the date range — so a team always has the
// same color.
const TEAM_COLORS = [
  "#4ea1ff", "#ff8a4e", "#5ee6a0", "#e659c9", "#f4d35e", "#9d8cff", "#ff5c5c", "#5ec8e6",
];

// null for a name that isn't one of the season's teams.
function getTeamColor(season, name) {
  const index = getTeamsForSeason(season).findIndex((t) => t.name === name);
  return index < 0 ? null : TEAM_COLORS[index % TEAM_COLORS.length];
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
    const resolved = resolvePlayer(previousRosterIndex, name, null, playerPositionHint(entry), playerIdHint(entry));
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
  const r = resolvePlayer(rosterIndex, playerName(entry), null, playerPositionHint(entry), playerIdHint(entry));
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

function playerIdHint(entry) {
  return (typeof entry === "object" && entry.id) || null;
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
