// Pool team rosters. Each team has a display name and a list of 20
// players. A player entry is either a plain full-name string, or an
// object { name, injured: true } to force-flag them as injured.
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
// PLACEHOLDER DATA — swap these four sample teams out for the real pool
// once rosters are finalized.
const TEAMS = [
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
    name: "Grinders",
    players: [
      { name: "Jordan Staal", injured: true }, "Ilya Mikheyev", "Jamie Benn", "Jake Neighbours",
      "Sean Monahan", "Sean Couturier", "Eeli Tolvanen", "Max Domi",
      "Ryan Poehling", "Morgan Rielly", "Thomas Harley", "John Marino",
      "Parker Kelly", "Blake Coleman", "Ben Kindel", "Fraser Minten",
      "Jean-Gabriel Pageau", "Michael Amadio", "Justin Sourdif", "Linus Karlsson",
    ],
  },
];

function playerName(entry) {
  return typeof entry === "string" ? entry : entry.name;
}

function playerIsInjured(entry) {
  return typeof entry === "object" && entry.injured === true;
}

function findTeamByName(name) {
  return TEAMS.find((t) => t.name === name);
}
