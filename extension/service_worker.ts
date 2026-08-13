/**
 * Empty message router for the MV3 service worker.
 * Content-script / offscreen handlers are added in later sections.
 *
 * Chrome loads the sibling `service_worker.js` until the 1.2 build
 * copies compiled output into `dist/`.
 */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void message;
  void sendResponse;
  // No routes registered yet — return false (sync, no async response).
  return false;
});
