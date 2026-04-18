// Service worker entry. MV3 service workers are ephemeral — keep all state in
// chrome.storage.* or IndexedDB. Do NOT rely on top-level variables to survive
// a termination/restart cycle.

// Lifecycle: install → activate → idle → terminated → restarted on event.

chrome.runtime.onInstalled.addListener((details) => {
  // First install, update, or chrome_update. Seed default settings here.
  console.debug('[sw] onInstalled', details.reason);
});

chrome.runtime.onStartup.addListener(() => {
  console.debug('[sw] onStartup');
});

// Placeholder: message router for popup/options/content -> SW RPC.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // TODO: route by msg.type. For now, always ack so the port closes cleanly.
  sendResponse({ ok: true, echoed: msg });
  return true; // keep channel open for async responses when we add them
});

export {};
