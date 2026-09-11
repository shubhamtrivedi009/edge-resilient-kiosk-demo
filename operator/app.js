const feedbackList = document.getElementById("feedbackList");
const emptyState = document.getElementById("emptyState");
const streamStatus = document.getElementById("streamStatus");
const refreshButton = document.getElementById("refreshButton");
const totalCount = document.getElementById("totalCount");
const averageRating = document.getElementById("averageRating");
const latestTime = document.getElementById("latestTime");

const items = new Map();

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function render() {
  const sorted = [...items.values()].sort((a, b) => b.id - a.id);
  emptyState.hidden = sorted.length > 0;

  feedbackList.innerHTML = sorted.map((item) => `
    <article class="card">
      <div class="card-top">
        <div>
          <strong>${escapeHtml(item.visitor_name || "Anonymous visitor")}</strong>
          <span>${formatTime(item.created_at)}</span>
        </div>
        <div class="rating">${"★".repeat(item.rating)}${"☆".repeat(5 - item.rating)}</div>
      </div>
      <p>${escapeHtml(item.comment || "No comment")}</p>
      <code>${escapeHtml(item.client_id.slice(0, 8))}…</code>
    </article>
  `).join("");

  totalCount.textContent = String(sorted.length);

  if (sorted.length) {
    const average = sorted.reduce((sum, item) => sum + item.rating, 0) / sorted.length;
    averageRating.textContent = average.toFixed(1);
    latestTime.textContent = formatTime(sorted[0].created_at);
  } else {
    averageRating.textContent = "—";
    latestTime.textContent = "—";
  }
}

async function loadFeedback() {
  refreshButton.disabled = true;
  try {
    const response = await fetch("/api/feedback");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    data.forEach((item) => items.set(item.id, item));
    render();
  } catch (error) {
    streamStatus.textContent = "API ERROR";
    streamStatus.dataset.state = "error";
    console.error(error);
  } finally {
    refreshButton.disabled = false;
  }
}

function connectEvents() {
  const source = new EventSource("/api/events");

  source.onopen = () => {
    streamStatus.textContent = "LIVE";
    streamStatus.dataset.state = "live";
  };

  source.addEventListener("feedback", (event) => {
    const item = JSON.parse(event.data);
    items.set(item.id, item);
    render();
  });

  source.onerror = () => {
    streamStatus.textContent = "RECONNECTING";
    streamStatus.dataset.state = "error";
  };
}

refreshButton.addEventListener("click", loadFeedback);

loadFeedback();
connectEvents();
