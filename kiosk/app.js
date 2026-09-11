const QUEUE_KEY = "edgeKiosk.pending.v1";
const OFFLINE_KEY = "edgeKiosk.demoOffline.v1";

const form = document.getElementById("feedbackForm");
const visitorName = document.getElementById("visitorName");
const rating = document.getElementById("rating");
const comment = document.getElementById("comment");
const submitButton = document.getElementById("submitButton");
const networkStatus = document.getElementById("networkStatus");
const pendingCount = document.getElementById("pendingCount");
const message = document.getElementById("message");
const offlineToggle = document.getElementById("offlineToggle");
const syncButton = document.getElementById("syncButton");

let syncing = false;
let demoOffline = localStorage.getItem(OFFLINE_KEY) === "true";

function getQueue() {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveQueue(items) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(items));
  updateStatus();
}

function setMessage(text, type = "info") {
  message.textContent = text;
  message.dataset.type = type;
}

function effectiveOnline() {
  return navigator.onLine && !demoOffline;
}

function updateStatus() {
  const pending = getQueue().length;
  pendingCount.textContent = String(pending);

  if (demoOffline) {
    networkStatus.textContent = "DEMO OFFLINE";
    networkStatus.dataset.state = "offline";
    offlineToggle.textContent = "Restore demo connectivity";
  } else if (navigator.onLine) {
    networkStatus.textContent = "ONLINE";
    networkStatus.dataset.state = "online";
    offlineToggle.textContent = "Enable demo offline mode";
  } else {
    networkStatus.textContent = "BROWSER OFFLINE";
    networkStatus.dataset.state = "offline";
    offlineToggle.textContent = "Enable demo offline mode";
  }
}

async function postFeedback(payload) {
  if (!effectiveOnline()) {
    throw new Error("offline");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);

  try {
    const response = await fetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${response.status}`);
    }

    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function enqueue(payload) {
  const queue = getQueue();
  queue.push(payload);
  saveQueue(queue);
}

async function syncQueue() {
  if (syncing || !effectiveOnline()) {
    updateStatus();
    return;
  }

  const queue = getQueue();
  if (queue.length === 0) {
    updateStatus();
    return;
  }

  syncing = true;
  syncButton.disabled = true;

  let remaining = [...queue];
  let syncedCount = 0;

  while (remaining.length && effectiveOnline()) {
    const item = remaining[0];

    try {
      await postFeedback(item);
      remaining.shift();
      syncedCount += 1;
      saveQueue(remaining);
    } catch {
      break;
    }
  }

  syncing = false;
  syncButton.disabled = false;
  updateStatus();

  if (syncedCount > 0) {
    setMessage(`Synchronized ${syncedCount} queued submission${syncedCount === 1 ? "" : "s"}.`, "success");
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!rating.value) {
    setMessage("Choose a rating before submitting.", "error");
    return;
  }

  const payload = {
    client_id: crypto.randomUUID(),
    visitor_name: visitorName.value.trim(),
    rating: Number(rating.value),
    comment: comment.value.trim(),
  };

  submitButton.disabled = true;

  try {
    await postFeedback(payload);
    setMessage("Submitted directly to the local service.", "success");
  } catch {
    enqueue(payload);
    setMessage("Service unavailable. Submission stored locally and queued for retry.", "queued");
  } finally {
    form.reset();
    submitButton.disabled = false;
    updateStatus();
  }
});

offlineToggle.addEventListener("click", () => {
  demoOffline = !demoOffline;
  localStorage.setItem(OFFLINE_KEY, String(demoOffline));
  updateStatus();

  if (demoOffline) {
    setMessage("Demo offline mode enabled. New submissions will be queued locally.", "queued");
  } else {
    setMessage("Connectivity restored. Synchronizing queued submissions…", "info");
    syncQueue();
  }
});

syncButton.addEventListener("click", () => {
  setMessage("Checking the pending queue…", "info");
  syncQueue();
});

window.addEventListener("online", () => {
  updateStatus();
  syncQueue();
});

window.addEventListener("offline", updateStatus);

updateStatus();
syncQueue();
setInterval(syncQueue, 5000);
