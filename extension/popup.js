const startBtn = document.getElementById("startBtn");
const optionsBtn = document.getElementById("optionsBtn");
const statusEl = document.getElementById("status");

startBtn.addEventListener("click", async () => {
  setStatus("Starting relay login...", "");
  startBtn.disabled = true;

  try {
    const response = await chrome.runtime.sendMessage({ type: "start-login-flow" });
    if (!response?.ok) {
      throw new Error(response?.error || "Failed to start login flow");
    }

    const authUrl = response.result?.auth_url;
    setStatus(
      authUrl
        ? `Auth flow started. Opened:\n${authUrl}`
        : "Auth flow started.",
      "ok"
    );
  } catch (error) {
    setStatus(String(error.message || error), "err");
  } finally {
    startBtn.disabled = false;
  }
});

optionsBtn.addEventListener("click", () => {
  if (chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  }
});

async function loadSettingsPreview() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "get-relay-settings" });
    if (!response?.ok) {
      throw new Error(response?.error || "Could not read settings");
    }
    const base = response.settings?.authManagerBaseUrl || "(not set)";
    setStatus(`auth-manager: ${base}`, "");
  } catch (error) {
    setStatus(`Settings error: ${String(error.message || error)}`, "err");
  }
}

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = `status ${cls}`.trim();
}

void loadSettingsPreview();
