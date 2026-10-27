// Trade-deadline reminder: a dismissible banner under the nav on the pool
// pages (Standings, Team, Games). It appears from a week before the
// season's deadline (see tradeDeadline in teams.js) and stays up, adjusting
// its wording, until the day-of reminder takes over; the day-of reminder is
// shown again even if the earlier one was dismissed, and it goes away once
// the deadline passes. Each is dismissed on its own and remembered in
// localStorage (which can be missing or blocked — then it just comes back
// on the next page).
//
// ?preview-deadline=week (or =day) in the URL shows either reminder
// without waiting for the real dates; those are never remembered as dismissed.

const DEADLINE_DISMISSED_KEY = "hockeypool-deadline-dismissed";
const DEADLINE_WEEK_DAYS = 7; // how far ahead the first reminder starts
const DEADLINE_DAY_MS = 24 * 60 * 60 * 1000;

// Whole Eastern calendar days from `now` to the deadline's day (0 = today).
function deadlineDaysUntil(deadline, now) {
  const asUtcNoon = (ymd) => new Date(`${ymd}T12:00:00Z`).getTime();
  return Math.round((asUtcNoon(easternDate(deadline)) - asUtcNoon(easternDate(now))) / DEADLINE_DAY_MS);
}

// "Monday, March 1" and "3 PM ET" — the deadline in Eastern time, which is
// where the NHL sets it, whatever timezone the page is viewed from.
function formatDeadlineParts(deadline) {
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric",
  }).format(deadline);
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "numeric", minute: "2-digit",
  }).format(deadline).replace(":00", "");
  return { day, time: `${time} ET` };
}

// Which reminder applies at `now`, if any: { stage: "week" | "day", text }.
function tradeDeadlineNotice(deadline, now = new Date()) {
  if (!deadline || now >= deadline) return null;
  const days = deadlineDaysUntil(deadline, now);
  const { day, time } = formatDeadlineParts(deadline);
  if (days === 0) {
    return { stage: "day", text: `Reminder: ${day} at ${time} is the trade deadline — that's today.` };
  }
  if (days > 0 && days <= DEADLINE_WEEK_DAYS) {
    const when = days === 1 ? "tomorrow" : `in ${days} days`;
    return { stage: "week", text: `Heads up: ${day} at ${time} is the trade deadline (${when}).` };
  }
  return null;
}

function deadlineDismissals() {
  try {
    return JSON.parse(localStorage.getItem(DEADLINE_DISMISSED_KEY)) || [];
  } catch {
    return [];
  }
}

function rememberDeadlineDismissal(id) {
  try {
    localStorage.setItem(DEADLINE_DISMISSED_KEY, JSON.stringify([...deadlineDismissals(), id].slice(-20)));
  } catch {
    // ignore (storage full/disabled)
  }
}

function showTradeDeadlineNotice() {
  const nav = document.querySelector(".site-nav");
  if (!nav || typeof getPoolSeasons !== "function" || typeof getTradeDeadline !== "function") return;

  const existing = document.querySelector(".deadline-notice");
  const seasons = getPoolSeasons();
  const deadline = getTradeDeadline(seasons[seasons.length - 1]);
  if (!deadline) {
    if (existing) existing.remove();
    return;
  }

  const preview = new URLSearchParams(location.search).get("preview-deadline");
  const now = preview === "week" ? new Date(deadline.getTime() - 5 * DEADLINE_DAY_MS)
    : preview === "day" ? new Date(deadline.getTime() - 3 * 60 * 60 * 1000)
    : new Date();

  const notice = tradeDeadlineNotice(deadline, now);
  const id = notice && `${deadline.toISOString()}|${notice.stage}`;
  const wanted = notice && (preview || !deadlineDismissals().includes(id));
  // Unchanged since the last check (a tab regaining focus): leave it be
  // rather than replaying its entrance.
  if (existing && wanted && existing.dataset.id === id && existing.dataset.text === notice.text) return;
  if (existing) existing.remove();
  if (!wanted) return;

  const bar = document.createElement("div");
  bar.className = `deadline-notice ${notice.stage}`;
  bar.dataset.id = id;
  bar.dataset.text = notice.text;
  bar.setAttribute("role", "status");
  bar.innerHTML = `
    <span class="deadline-notice-icon" aria-hidden="true">⏰</span>
    <span class="deadline-notice-text"></span>
    <button type="button" class="deadline-notice-close" aria-label="Dismiss the trade deadline reminder" title="Dismiss">×</button>
  `;
  bar.querySelector(".deadline-notice-text").textContent = notice.text;
  bar.querySelector(".deadline-notice-close").addEventListener("click", () => {
    if (!preview) rememberDeadlineDismissal(id);
    bar.remove();
  });
  nav.insertAdjacentElement("afterend", bar);
}

showTradeDeadlineNotice();
// A tab left open overnight moves from the week reminder to the day-of one
// (and past the deadline) without a reload.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") showTradeDeadlineNotice();
});
