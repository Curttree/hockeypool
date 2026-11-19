// Every skater the NHL's stats API returns for `params` (the query minus
// start and limit). The API answers at most 100 rows a request whatever
// `limit` says (limit=-1 used to return every row), so this walks the pages:
// sorted by name then playerId — a unique key, so the pages tile exactly —
// and refuses a result that isn't the whole set. Built-in fetch only.
const STATS_URL = "https://api.nhle.com/stats/rest/en/skater/summary";
const PAGE_SIZE = 100;

export async function fetchAllSkaters(params) {
  const page = async (start) => {
    const query = new URLSearchParams({
      isAggregate: "false",
      isGame: "false",
      sort: JSON.stringify([{ property: "skaterFullName", direction: "ASC" }, { property: "playerId", direction: "ASC" }]),
      factCayenneExp: "gamesPlayed>=1",
      ...params,
      start: String(start),
      limit: String(PAGE_SIZE),
    });
    const res = await fetch(`${STATS_URL}?${query}`, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) throw new Error(`NHL stats API returned ${res.status}`);
    return res.json();
  };
  const first = await page(0);
  const total = first.total ?? (first.data || []).length;
  const starts = [];
  for (let start = PAGE_SIZE; start < total; start += PAGE_SIZE) starts.push(start);
  const rest = await Promise.all(starts.map(page));
  const rows = [first, ...rest].flatMap((body) => body.data || []);
  const unique = new Map(rows.map((p) => [p.playerId, p]));
  if (unique.size !== total) throw new Error(`Partial response: ${unique.size} skaters of ${total}`);
  return { total, rows: [...unique.values()] };
}
