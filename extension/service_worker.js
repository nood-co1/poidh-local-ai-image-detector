/**
 * Empty message router for the MV3 service worker (loadable JS for Chrome).
 * Source of truth for typing: service_worker.ts. Build (1.2) will emit JS to dist/.
 */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void message;
  void sendResponse;
  // No routes registered yet — return false (sync, no async response).
  return false;
});
