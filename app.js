const seasonSelect = document.getElementById("season");
const limitSelect = document.getElementById("limit");
const searchInput = document.getElementById("search");
const maxPointsInput = document.getElementById("max-points");
const statusEl = document.getElementById("status");
const table = document.getElementById("players-table");
const tbody = table.querySelector("tbody");
const pager = document.getElementById("pager");
const pageInfo = document.getElementById("page-info");
const prevBtn = document.getElementById("prev-page");
const nextBtn = document.getElementById("next-page");
const pageJumpInput = document.getElementById("page-jump-input");
const pageCount = document.getElementById("page-count");
const sortableHeaders = document.querySelectorAll("th.sortable");
const selectedSection = document.getElementById("selected-section");
const selectedTitle = document.getElementById("selected-title");
const selectedCount = document.getElementById("selected-count");
const selectedEmpty = document.getElementById("selected-empty");
const selectedTable = document.getElementById("selected-table");
const selectedTbody = selectedTable.querySelector("tbody");
const clearSelectedBtn = document.getElementById("clear-selected");
const exportCsvBtn = document.getElementById("export-csv");
const selectedTotal = document.getElementById("selected-total");
const selectedTotalValue = document.getElementById("selected-total-value");
const fill20Btn = document.getElementById("fill-20");
const fillStatus = document.getElementById("fill-status");

const TEXT_COLUMNS = new Set(["player", "team", "pos"]);
const SELECTED_STORAGE_KEY = "nhl-points-selected-players";
const HIGH_TOTAL_THRESHOLD = 1000;
const MAX_EXPORT_PLAYERS = 20;
const FILL_TARGET_COUNT = 20;
const FILL_POINTS_CAP = 1000;

// Fill this in with your deployed Cloudflare Worker's *.workers.dev URL
// (see worker.js) after publishing to GitHub Pages. Localhost keeps using
// the relative /api paths served by app.py.
const WORKER_URL = "https://hockeypool-proxy.curttremblay.workers.dev";
const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname);
const API_BASE = isLocal ? "" : WORKER_URL;

let start = 0;
let totalPages = 1;
let searchDebounce = null;
let sortProp = "p";
let sortDir = "DESC";

let selectedPlayers = new Map();
try {
  const stored = JSON.parse(localStorage.getItem(SELECTED_STORAGE_KEY) || "[]");
  selectedPlayers = new Map(stored.map((p) => [p.playerId, p]));
} catch {
  selectedPlayers = new Map();
}

function saveSelected() {
  try {
    localStorage.setItem(SELECTED_STORAGE_KEY, JSON.stringify([...selectedPlayers.values()]));
  } catch {
    // ignore (private browsing / storage disabled)
  }
}

function renderSelected() {
  const players = [...selectedPlayers.values()];
  selectedCount.textContent = players.length;
  clearSelectedBtn.hidden = players.length === 0;
  exportCsvBtn.hidden = players.length === 0;
  selectedTotal.hidden = players.length === 0;
  selectedEmpty.hidden = players.length > 0;
  selectedTable.hidden = players.length === 0;

  const totalPoints = players.reduce((sum, p) => sum + p.points, 0);
  selectedTotalValue.textContent = totalPoints;
  const overCount = players.length > MAX_EXPORT_PLAYERS;
  const overPoints = totalPoints > HIGH_TOTAL_THRESHOLD;
  selectedTotal.classList.toggle("total-high", overPoints);
  selectedTitle.classList.toggle("title-high", overCount);

  exportCsvBtn.disabled = overCount || overPoints;
  if (overCount && overPoints) {
    exportCsvBtn.title = `Export disabled: more than ${MAX_EXPORT_PLAYERS} players and total over ${HIGH_TOTAL_THRESHOLD} points.`;
  } else if (overCount) {
    exportCsvBtn.title = `Export disabled: more than ${MAX_EXPORT_PLAYERS} players selected.`;
  } else if (overPoints) {
    exportCsvBtn.title = `Export disabled: total points exceed ${HIGH_TOTAL_THRESHOLD}.`;
  } else {
    exportCsvBtn.title = "";
  }

  selectedTbody.innerHTML = "";
  players
    .sort((a, b) => b.points - a.points)
    .forEach((p) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${p.skaterFullName}</td>
        <td>${p.teamAbbrevs}</td>
        <td>${p.positionCode}</td>
        <td class="num">${p.points}</td>
        <td class="num"><button class="remove-btn" data-id="${p.playerId}" title="Remove">✕</button></td>
      `;
      selectedTbody.appendChild(tr);
    });
}

function csvField(value) {
  const str = String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function exportSelectedAsCsv() {
  const players = [...selectedPlayers.values()].sort((a, b) => b.points - a.points);
  const header = ["Player", "Team", "Pos", "GP", "G", "A", "P", "+/-"];
  const rows = players.map((p) => [
    p.skaterFullName, p.teamAbbrevs, p.positionCode,
    p.gamesPlayed, p.goals, p.assists, p.points, p.plusMinus,
  ]);
  const csv = [header, ...rows].map((row) => row.map(csvField).join(",")).join("\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "selected-players.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function toggleSelected(player, isSelected) {
  if (isSelected) {
    selectedPlayers.set(player.playerId, player);
  } else {
    selectedPlayers.delete(player.playerId);
  }
  saveSelected();
  renderSelected();
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// In-memory + sessionStorage cache for full-season rosters, so repeated
// "Fill to 20" clicks (or a page reload within the same tab) don't
// re-issue the ~10 paginated requests every time for data that's the
// same all season.
const ROSTER_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
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

// The NHL API caps each request at 100 rows, so a full-season roster
// (~900+ skaters) needs to be paginated.
async function fetchAllPlayersForSeason(season) {
  const cached = getCachedRoster(season);
  if (cached) return cached;

  const pageSize = 100;
  const first = await fetch(`${API_BASE}/api/players?${new URLSearchParams({ season, limit: pageSize, start: 0 })}`)
    .then((r) => r.json());
  const all = [...first.players];
  const starts = [];
  for (let s = pageSize; s < first.total; s += pageSize) starts.push(s);

  const rest = await Promise.all(starts.map((s) =>
    fetch(`${API_BASE}/api/players?${new URLSearchParams({ season, limit: pageSize, start: s })}`).then((r) => r.json())
  ));
  rest.forEach((page) => all.push(...page.players));

  setCachedRoster(season, all);
  return all;
}

// One random pass: shuffle candidates and greedily take the first ones
// that fit under budget, up to `needed` of them.
function attemptFill(candidates, needed, budget) {
  const shuffled = shuffle([...candidates]);
  const chosen = [];
  let total = 0;
  for (const p of shuffled) {
    if (chosen.length >= needed) break;
    if (total + p.points <= budget) {
      chosen.push(p);
      total += p.points;
    }
  }
  return { chosen, total };
}

// Hill-climb the chosen set: repeatedly swap a chosen player for an
// unchosen one whenever that raises the total without exceeding budget.
function refineTowardBudget(chosen, total, pool, budget) {
  const chosenIds = new Set(chosen.map((p) => p.playerId));
  const unchosen = pool.filter((p) => !chosenIds.has(p.playerId));

  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < chosen.length; i++) {
      for (let j = 0; j < unchosen.length; j++) {
        const newTotal = total - chosen[i].points + unchosen[j].points;
        if (newTotal <= budget && newTotal > total) {
          const swappedOut = chosen[i];
          chosen[i] = unchosen[j];
          unchosen[j] = swappedOut;
          total = newTotal;
          improved = true;
          break;
        }
      }
    }
  }
  return { chosen, total };
}

// Random sampling (many shuffled attempts, keeping the best) followed by
// a local-search refinement, so the result both stays randomized and
// lands as close to the points cap as possible.
function pickPlayersNearBudget(candidates, needed, budget, trials = 400) {
  let best = { chosen: [], total: 0 };
  for (let i = 0; i < trials; i++) {
    const attempt = attemptFill(candidates, needed, budget);
    const better = attempt.chosen.length > best.chosen.length
      || (attempt.chosen.length === best.chosen.length && attempt.total > best.total);
    if (better) best = attempt;
    if (best.chosen.length === needed && best.total === budget) break;
  }
  return refineTowardBudget(best.chosen, best.total, candidates, budget);
}

async function fillToTarget() {
  const needed = FILL_TARGET_COUNT - selectedPlayers.size;
  fillStatus.hidden = false;

  if (needed <= 0) {
    fillStatus.textContent = `You already have ${selectedPlayers.size} players selected.`;
    return;
  }

  const currentTotal = [...selectedPlayers.values()].reduce((sum, p) => sum + p.points, 0);
  if (currentTotal >= FILL_POINTS_CAP) {
    fillStatus.textContent = `Selected players already total ${currentTotal} points (≥ ${FILL_POINTS_CAP}) — can't add more while keeping the total under ${FILL_POINTS_CAP}.`;
    return;
  }

  fill20Btn.disabled = true;
  fillStatus.textContent = "Finding players…";

  try {
    const season = seasonSelect.value;
    const pool = await fetchAllPlayersForSeason(season);
    const candidates = pool.filter((p) => !selectedPlayers.has(p.playerId));
    const budget = FILL_POINTS_CAP - currentTotal;

    const { chosen, total: addedPoints } = pickPlayersNearBudget(candidates, needed, budget);
    chosen.forEach((p) => selectedPlayers.set(p.playerId, p));
    const runningTotal = currentTotal + addedPoints;
    const added = chosen.length;

    saveSelected();
    renderSelected();
    tbody.querySelectorAll(".select-checkbox").forEach((cb) => {
      cb.checked = selectedPlayers.has(Number(cb.dataset.id));
    });

    if (selectedPlayers.size >= FILL_TARGET_COUNT) {
      fillStatus.textContent = `Added ${added} random player${added === 1 ? "" : "s"} — now ${selectedPlayers.size} selected, total ${runningTotal} points.`;
    } else {
      fillStatus.textContent = `Added ${added} random player${added === 1 ? "" : "s"}, but could only reach ${selectedPlayers.size} of ${FILL_TARGET_COUNT} while keeping the total ≤ ${FILL_POINTS_CAP} (total ${runningTotal}). Not enough low-point players left unselected.`;
    }
  } catch (err) {
    fillStatus.textContent = `Error: ${err.message}`;
  } finally {
    fill20Btn.disabled = false;
  }
}

function goToPage(page) {
  const clamped = Math.min(Math.max(1, page), totalPages);
  start = (clamped - 1) * Number(limitSelect.value);
  loadPlayers();
}

function buildSeasonOptions(lastSeasonId) {
  const startYear = parseInt(lastSeasonId.slice(0, 4), 10);
  seasonSelect.innerHTML = "";
  for (let i = 0; i < 10; i++) {
    const y = startYear - i;
    const id = `${y}${y + 1}`;
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = `${y}-${y + 1}`;
    seasonSelect.appendChild(opt);
  }
  seasonSelect.value = lastSeasonId;
}

async function loadPlayers() {
  statusEl.hidden = false;
  statusEl.textContent = "Loading…";
  table.hidden = true;
  pager.hidden = true;

  const season = seasonSelect.value;
  const limit = limitSelect.value;
  const search = searchInput.value.trim();
  const maxPoints = maxPointsInput.value.trim();

  const params = new URLSearchParams({ season, limit, start, sort: sortProp, dir: sortDir });
  if (search) params.set("search", search);
  if (maxPoints !== "") params.set("maxPoints", maxPoints);

  try {
    const res = await fetch(`${API_BASE}/api/players?${params}`);
    if (!res.ok) throw new Error(`Request failed (${res.status})`);
    const { players, total } = await res.json();

    if (!players.length) {
      const filters = [];
      if (search) filters.push(`name matching "${search}"`);
      if (maxPoints !== "") filters.push(`points ≤ ${maxPoints}`);
      statusEl.textContent = filters.length
        ? `No players found for ${filters.join(" and ")}.`
        : "No data found for that season.";
      return;
    }

    tbody.innerHTML = "";
    players.forEach((p, i) => {
      const tr = document.createElement("tr");
      const checked = selectedPlayers.has(p.playerId) ? "checked" : "";
      tr.innerHTML = `
        <td class="num">${start + i + 1}</td>
        <td class="checkbox-col"><input type="checkbox" class="select-checkbox" data-id="${p.playerId}" ${checked}></td>
        <td>${p.skaterFullName}</td>
        <td>${p.teamAbbrevs}</td>
        <td>${p.positionCode}</td>
        <td class="num">${p.gamesPlayed}</td>
        <td class="num">${p.goals}</td>
        <td class="num">${p.assists}</td>
        <td class="num">${p.points}</td>
        <td class="num">${p.plusMinus > 0 ? "+" + p.plusMinus : p.plusMinus}</td>
      `;
      tr.querySelector(".select-checkbox").addEventListener("change", (e) => {
        toggleSelected(p, e.target.checked);
      });
      tbody.appendChild(tr);
    });

    const limitNum = Number(limitSelect.value);
    const lastRow = Math.min(start + players.length, total);
    const currentPage = Math.floor(start / limitNum) + 1;
    totalPages = Math.max(1, Math.ceil(total / limitNum));

    pageInfo.textContent = `${start + 1}–${lastRow} of ${total}`;
    prevBtn.disabled = start === 0;
    nextBtn.disabled = lastRow >= total;

    pageJumpInput.max = totalPages;
    pageJumpInput.value = currentPage;
    pageCount.textContent = `of ${totalPages}`;

    sortableHeaders.forEach((th) => {
      const arrow = th.querySelector(".sort-arrow");
      arrow.textContent = th.dataset.sort === sortProp ? (sortDir === "ASC" ? " ▲" : " ▼") : "";
    });

    statusEl.hidden = true;
    table.hidden = false;
    pager.hidden = false;
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  }
}

async function init() {
  try {
    const res = await fetch(`${API_BASE}/api/season`);
    const { season } = await res.json();
    buildSeasonOptions(season);
  } catch {
    buildSeasonOptions("20252026");
  }
  renderSelected();
  await loadPlayers();

  seasonSelect.addEventListener("change", () => { start = 0; loadPlayers(); });
  limitSelect.addEventListener("change", () => { start = 0; loadPlayers(); });

  searchInput.addEventListener("input", () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => { start = 0; loadPlayers(); }, 300);
  });

  maxPointsInput.addEventListener("input", () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => { start = 0; loadPlayers(); }, 300);
  });

  prevBtn.addEventListener("click", () => {
    const currentPage = Math.floor(start / Number(limitSelect.value)) + 1;
    goToPage(currentPage - 1);
  });

  nextBtn.addEventListener("click", () => {
    const currentPage = Math.floor(start / Number(limitSelect.value)) + 1;
    goToPage(currentPage + 1);
  });

  pageJumpInput.addEventListener("change", () => {
    goToPage(Number(pageJumpInput.value) || 1);
  });

  pageJumpInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") goToPage(Number(pageJumpInput.value) || 1);
  });

  sortableHeaders.forEach((th) => {
    th.addEventListener("click", () => {
      const col = th.dataset.sort;
      if (col === sortProp) {
        sortDir = sortDir === "ASC" ? "DESC" : "ASC";
      } else {
        sortProp = col;
        sortDir = TEXT_COLUMNS.has(col) ? "ASC" : "DESC";
      }
      start = 0;
      loadPlayers();
    });
  });

  clearSelectedBtn.addEventListener("click", () => {
    selectedPlayers.clear();
    saveSelected();
    renderSelected();
    tbody.querySelectorAll(".select-checkbox").forEach((cb) => { cb.checked = false; });
    fillStatus.hidden = true;
  });

  exportCsvBtn.addEventListener("click", exportSelectedAsCsv);

  fill20Btn.addEventListener("click", fillToTarget);

  selectedTbody.addEventListener("click", (e) => {
    const btn = e.target.closest(".remove-btn");
    if (!btn) return;
    const playerId = Number(btn.dataset.id);
    selectedPlayers.delete(playerId);
    saveSelected();
    renderSelected();
    const checkbox = tbody.querySelector(`.select-checkbox[data-id="${playerId}"]`);
    if (checkbox) checkbox.checked = false;
  });
}

init();
