/**
 * Popup UI (section 2.2): Start / Retry setup, Ready + SHA display.
 * Talks to the service worker — never writes weights to chrome.storage.
 */

const statusEl = document.getElementById('status');
const shaEl = document.getElementById('sha');
const errorEl = document.getElementById('error');
const startBtn = document.getElementById('start');
const retryBtn = document.getElementById('retry');

/**
 * @param {unknown} err
 * @returns {string}
 */
function errText(err) {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * @param {{ ready?: boolean, sha256?: string|null, sha256Short?: string|null, error?: string }} status
 */
function renderStatus(status) {
  if (!statusEl || !shaEl || !errorEl || !startBtn || !retryBtn) return;

  if (status.ready) {
    statusEl.textContent = 'Ready';
    const sha = status.sha256Short || status.sha256 || '';
    shaEl.textContent = sha ? `SHA256 ${sha}` : '';
    errorEl.textContent = '';
    startBtn.hidden = true;
    startBtn.disabled = true;
    // Retry stays available for recovery (force re-download).
    retryBtn.hidden = false;
    retryBtn.disabled = false;
    retryBtn.textContent = 'Re-verify';
  } else {
    statusEl.textContent = 'models not ready';
    shaEl.textContent = '';
    errorEl.textContent = status.error ? String(status.error) : '';
    startBtn.hidden = false;
    startBtn.disabled = false;
    startBtn.textContent = 'Start setup';
    // Show Retry when a previous attempt failed.
    const showRetry = Boolean(status.error);
    retryBtn.hidden = !showRetry;
    retryBtn.disabled = false;
    retryBtn.textContent = 'Retry';
  }
}

function setBusy(busy) {
  if (startBtn) startBtn.disabled = busy;
  if (retryBtn) retryBtn.disabled = busy;
  if (busy && statusEl) {
    statusEl.textContent = 'Downloading models…';
  }
}

async function refreshStatus() {
  try {
    const status = await chrome.runtime.sendMessage({ type: 'ARTIFACT_STATUS' });
    renderStatus(status ?? { ready: false });
  } catch (err) {
    renderStatus({ ready: false, error: errText(err) });
  }
}

/**
 * @param {boolean} force
 */
async function runSetup(force) {
  setBusy(true);
  if (errorEl) errorEl.textContent = '';
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'SETUP_ARTIFACTS',
      force: Boolean(force),
    });
    if (!result || result.ok === false || result.ready === false) {
      renderStatus({
        ready: false,
        error: (result && result.error) || 'setup failed',
      });
      return;
    }
    renderStatus({
      ready: true,
      sha256: result.sha256,
      sha256Short: result.sha256Short,
    });
  } catch (err) {
    renderStatus({ ready: false, error: errText(err) });
  } finally {
    setBusy(false);
  }
}

if (startBtn) {
  startBtn.addEventListener('click', () => {
    void runSetup(false);
  });
}
if (retryBtn) {
  retryBtn.addEventListener('click', () => {
    void runSetup(true);
  });
}

void refreshStatus();
