/**
 * Popup UI (1.1 skeleton). Models and inference arrive in later sections.
 * Keeps the static "models not ready" message visible.
 */
const statusEl = document.getElementById('status');
if (statusEl) {
  statusEl.textContent = 'models not ready';
}
