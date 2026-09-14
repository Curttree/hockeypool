// Pool team rosters, keyed by season since a fresh draft happens every
// year — a given season's array only lists the teams that played that
// year, so a team can be added or removed just by including/omitting it
// from a season's list. Team names stay stable across years for teams
// that continue (they're the lookup key used by team.html's links).
//
// Each team has a display name and a list of 20 players. A player entry
// is either a plain full-name string, or an object { name, injured: true }
// to force-flag them as injured.
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
  "20242025": [
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
  "20252026": [
    {
      name: "Ice Breakers",
      players: [
        "Connor McDavid", { name: "Nathan MacKinnon", injured: true }, "Nikita Kucherov", "Macklin Celebrini",
        "Mark Scheifele", "Nick Suzuki", "Martin Necas", "David Pastrnak",
        "Leon Draisaitl", "Jason Robertson", "Evan Bouchard", "Kyle Connor",
        "Jack Eichel", "Kirill Kaprizov", "Cole Caufield", "Jake Guentzel",
        "Clayton Keller", "Wyatt Johnston", "Matt Boldy", "Alex DeBrincat",
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
};

function getPoolSeasons() {
  return Object.keys(TEAMS_BY_SEASON).sort();
}

function getTeamsForSeason(season) {
  return TEAMS_BY_SEASON[season] || [];
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
