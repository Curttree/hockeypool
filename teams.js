// Pool data, keyed by season since a fresh draft happens every year.
// Each season is { teams, trades }:
//
// - teams: a given season's array only lists the teams that played that
//   year, so a team can be added or removed just by including/omitting
//   it. Team names stay stable across years for teams that continue
//   (they're the lookup key used by team.html's links). Each team has a
//   display name and a list of players. A player entry is either a
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
// Injury status is normally detected automatically on the team detail
// page (see common.js's fetchInjuries, sourced from ESPN's public
// feed since the NHL's own API has no injury data). The manual
// `injured: true` flag is just a fallback/override for cases the feed
// misses — you shouldn't need to set it by hand under normal use.
//
// Names must match the NHL API's "skaterFullName" spelling exactly,
// e.g. "Tim Stützle".
//
// PLACEHOLDER DATA — swap these sample seasons/teams out for the real
// pool. Add a new season by adding another key here; nothing else in
// the code needs to change.
const TEAMS_BY_SEASON = {
  "20242025": {
    teams: [
      {
        name: "Ice Breakers",
        players: [
          "Nikita Kucherov", "Nathan MacKinnon", "David Pastrnak", "Leon Draisaitl",
          "Mitch Marner", "Connor McDavid", "Kyle Connor", "Jack Eichel",
          "Cale Makar", "Sidney Crosby", "Clayton Keller", "Brandon Hagel",
          "Nick Suzuki", "Artemi Panarin", "Jesper Bratt", "Mikko Rantanen",
          "Mark Scheifele", "William Nylander", "Martin Necas", "Zach Werenski",
        ],
      },
      {
        name: "Blue Line Bandits",
        players: [
          "Matt Duchene", "Brayden Point", "Dylan Strome", "Sam Reinhart",
          "Robert Thomas", "Jake Guentzel", "Jason Robertson", "Lucas Raymond",
          "Tim Stützle", "Auston Matthews", "Filip Forsberg", "Quinn Hughes",
          "Travis Konecny", "Kirill Marchenko", "John Tavares", "Sebastian Aho",
          "Alex Ovechkin", "Adrian Kempe", "Matt Boldy", "Tage Thompson",
        ],
      },
      {
        name: "Puck Hogs",
        players: [
          "Wyatt Johnston", "Aleksander Barkov", "Dylan Larkin", "Alex DeBrincat",
          "Jack Hughes", "Jordan Kyrou", "Rickard Rakell", "J.T. Miller",
          "Cole Caufield", "Nico Hischier", "John-Jason Peterka", "Rasmus Dahlin",
          "Drake Batherson", "Roope Hintz", "Evan Bouchard", "Mark Stone",
          "Connor Bedard", "Nazem Kadri", "Alex Tuch", "Seth Jarvis",
        ],
      },
      {
        // Didn't return for the 2025-2026 season — see the "Grinders"
        // note below for the team that joined in its place.
        name: "Slap Shots",
        players: [
          "Aliaksei Protas", "Victor Hedman", "Mikael Granlund", "Pierre-Luc Dubois",
          "Lane Hutson", "Bryan Rust", "Tom Wilson", "Logan Cooley",
          "Nick Schmaltz", "Dylan Holloway", "Matvei Michkov", "Macklin Celebrini",
          "Nikolaj Ehlers", "Josh Morrissey", "Ryan Donato", "Mika Zibanejad",
          "Jonathan Huberdeau", "Gabriel Vilardi", "Jared McCann", "Adam Fox",
        ],
      },
    ],
    trades: [],
  },
  "20252026": {
    teams: [
      {
        name: "Ice Breakers",
        players: [
          "Connor McDavid", { name: "Nathan MacKinnon", injured: true }, "Nikita Kucherov", "Macklin Celebrini",
          "Mark Scheifele", "Nick Suzuki", "Martin Necas", "David Pastrnak",
          "Leon Draisaitl", "Jason Robertson", "Evan Bouchard", "Kyle Connor",
          "Jack Eichel", "Kirill Kaprizov", "Cole Caufield", "Jake Guentzel",
          "Clayton Keller", "Wyatt Johnston", "Matt Boldy", "Alex DeBrincat",
          // Traded away mid-season — see `trades` below. Still listed,
          // shown with a "Traded" badge on the team page.
          "Jordan Kyrou",
        ],
      },
      {
        name: "Blue Line Bandits",
        players: [
          "Artemi Panarin", "Tim Stützle", { name: "Zach Werenski", injured: true }, "Tage Thompson",
          "Mitch Marner", "Sebastian Aho", "William Nylander", "Cale Makar",
          "Mika Zibanejad", "Lane Hutson", "Jack Hughes", "Mikko Rantanen",
          "Lucas Raymond", "Quinn Hughes", "Filip Forsberg", "Connor Bedard",
          "Brandon Hagel", "Nick Schmaltz", "Sidney Crosby", "Ryan O'Reilly",
        ],
      },
      {
        name: "Puck Hogs",
        players: [
          { name: "Rasmus Dahlin", injured: true }, "Dylan Guenther", "Adrian Kempe", "Juraj Slafkovský",
          "Mark Stone", "Mathew Barzal", "Drake Batherson", "John Tavares",
          "Nikolaj Ehlers", "Jesper Bratt", "Peyton Krebs", "Dougie Hamilton",
          "Shea Theodore", "Oliver Ekman-Larsson", "Will Cuylle", "Joel Farabee",
          "Erik Haula", "Boone Jenner", "Anze Kopitar", "Jack Roslovic",
        ],
      },
      {
        // New for 2025-2026, replacing "Slap Shots".
        name: "Grinders",
        players: [
          { name: "Jordan Staal", injured: true }, "Ilya Mikheyev", "Jamie Benn", "Jake Neighbours",
          "Sean Monahan", "Sean Couturier", "Eeli Tolvanen", "Max Domi",
          "Ryan Poehling", "Morgan Rielly", "Thomas Harley", "John Marino",
          "Parker Kelly", "Blake Coleman", "Ben Kindel", "Fraser Minten",
          "Jean-Gabriel Pageau", "Michael Amadio", "Justin Sourdif", "Linus Karlsson",
        ],
      },
    ],
    trades: [
      {
        team: "Ice Breakers",
        // DeBrincat had 27g/33a (60 pts) at the trade date — he's since
        // kept scoring for his new team, but that no longer counts here.
        playerOut: { name: "Alex DeBrincat", points: 60, goals: 27, assists: 33 },
        // Kyrou had 8g/12a (20 pts) before the trade; only production
        // since joining Ice Breakers counts toward their total.
        playerIn: { name: "Jordan Kyrou", points: 20, goals: 8, assists: 12 },
      },
    ],
  },
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

  getTradesForSeason(season).forEach((trade) => {
    if (trade.team !== teamName) return;
    if (trade.playerIn && trade.playerIn.name === playerName) {
      const { points, goals, assists } = trade.playerIn;
      entry = { points, goals, assists };
    }
    if (trade.playerOut && trade.playerOut.name === playerName) {
      const { points, goals, assists } = trade.playerOut;
      exit = { points, goals, assists };
    }
  });

  return { entry, exit, tradedOut: exit !== null };
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
