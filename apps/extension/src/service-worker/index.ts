// Service worker entry.
//
// MV3 service workers are ephemeral: Chrome terminates them after ~30s of
// idle and wakes them up on any matching event. That means two things:
//   1. Never stash state in module-scoped variables expecting it to
//      survive — use chrome.storage or re-derive on wake-up.
//   2. Do as little as possible in each event handler. Long-running work
//      keeps the SW alive (fine) but also keeps the user's battery drain
//      higher than necessary.
//
// Our SW's responsibilities are narrow:
//   - Reconcile the *enabled* set of DNR rulesets against user prefs in
//     chrome.storage.sync. Prefs are keyed by *source* id (the user-facing
//     list name — `easylist`, `easyprivacy`); the manifest declares the
//     underlying *chunk* ids (`easylist-1`, `easylist-2`, ...). The SW
//     translates source → chunk set here. See shared/messages.ts for why
//     the two namespaces exist.
//   - Reconcile DNR *session* rules against the per-site pause list in
//     chrome.storage.local. Each paused eTLD+1 gets one allowAllRequests
//     session rule. Session rules survive SW restarts but not browser
//     restarts; the storage list is the source of truth and we rehydrate
//     session rules from it on startup.
//   - Run the cosmetic-refresh alarm (slice 5.5). chrome.alarms fires
//     ~weekly; the SW fetches each enabled list from upstream, compiles
//     it via the wasm pipeline, and stashes the fresh `CosmeticBundle` in
//     chrome.storage.local. The content script reads from storage first,
//     falling back to the bundled `assets/cosmetic-<id>.json` files.
//     DNR rules are NOT auto-refreshed — Chrome's 5,000-rule cap on
//     dynamic rules makes that architecturally impossible in MV3.
//   - Respond to `popup:get-state` and the pause-toggle messages with
//     enough info to populate the popup.
//
// The static DNR rules themselves live in compile-time ruleset files
// (see scripts/build-rulesets.ts). The SW does not manipulate static
// rules at runtime — that's Chrome's job, off the manifest.

import { etldPlusOne } from '../shared/etld.js';
import {
  AUTO_REFRESH_KEY,
  CHUNK_IDS,
  COSMETIC_REFRESH_ALARM,
  PAUSED_HOSTS_KEY,
  PAUSE_RULE_ID_BASE,
  PAUSE_RULE_ID_MAX,
  PAUSE_RULE_PRIORITY,
  SOURCE_DEFAULTS,
  SOURCE_IDS,
  chunksForSource,
  type Message,
  type Response,
  type SourceId,
} from '../shared/messages.js';
import {
  initBadgeStyling,
  updateBadgeForActiveTab,
  updateBadgeForTab,
} from './badge.js';
import { runRefresh, setupRefreshAlarm } from './refresh.js';

/**
 * Read the user's per-source enable prefs from storage. Falls back to the
 * `SOURCE_DEFAULTS` map for any source that doesn't have a stored value
 * yet — that map is the single source of truth for default-on vs default-
 * off, shared with the content script so the two can never disagree.
 *
 * Storage keys are source ids, not chunk ids. The user doesn't toggle
 * individual chunks, and persisting per-chunk booleans would be a
 * forward-compat trap — changing CHUNKS_PER_SOURCE would orphan old keys.
 */
async function readSourcePrefs(): Promise<Record<SourceId, boolean>> {
  // Spread to a mutable array — `chrome.storage.sync.get` requires
  // `string[]`, and SOURCE_IDS is a readonly tuple for type-safety.
  const stored = await chrome.storage.sync.get([...SOURCE_IDS]);
  const out = {} as Record<SourceId, boolean>;
  for (const id of SOURCE_IDS) {
    // `typeof stored[id] !== 'boolean'` covers both "never set" and
    // "corrupted" — both fall back to the per-source default. Using a
    // typed default map (rather than blanket `true`) lets us add lists
    // like the annoyance pair which should ship off-by-default.
    out[id] =
      typeof stored[id] === 'boolean'
        ? (stored[id] as boolean)
        : SOURCE_DEFAULTS[id];
  }
  return out;
}

/**
 * Reconcile the DNR chunk enable state against the user's source-level
 * prefs. Expands each enabled source into its chunk set, then diffs
 * against Chrome's currently-enabled set.
 *
 * Chrome's updateEnabledRulesets takes two lists: ids to enable, ids to
 * disable. We only send the delta — no-op calls are cheap but clutter the
 * extension DevTools activity log.
 */
async function reconcileRulesets(): Promise<void> {
  const prefs = await readSourcePrefs();
  const currentEnabled = new Set(
    await chrome.declarativeNetRequest.getEnabledRulesets(),
  );

  // Build the target set by expanding each enabled source into chunks.
  // Disabled sources contribute nothing — their chunks land in the
  // "should be disabled" bucket below by virtue of not being here.
  const wantedEnabled = new Set<string>();
  for (const sourceId of SOURCE_IDS) {
    if (prefs[sourceId]) {
      for (const chId of chunksForSource(sourceId)) {
        wantedEnabled.add(chId);
      }
    }
  }

  const enableRulesetIds: string[] = [];
  const disableRulesetIds: string[] = [];
  // Iterate over every declared chunk — that way we also correct chunks
  // Chrome silently disabled under us (quota hits, etc.), not just ones
  // the user just toggled. CHUNK_IDS is the source of truth for "what the
  // manifest declares".
  for (const chId of CHUNK_IDS) {
    const wantOn = wantedEnabled.has(chId);
    const isOn = currentEnabled.has(chId);
    if (wantOn && !isOn) enableRulesetIds.push(chId);
    if (!wantOn && isOn) disableRulesetIds.push(chId);
  }

  if (enableRulesetIds.length === 0 && disableRulesetIds.length === 0) return;
  await chrome.declarativeNetRequest.updateEnabledRulesets({
    enableRulesetIds,
    disableRulesetIds,
  });
  console.debug('[sw] rulesets reconciled', { enableRulesetIds, disableRulesetIds });
}

// ---------------------------------------------------------------------------
// Pause-on-host: storage + DNR session rules.
// ---------------------------------------------------------------------------

/**
 * Read paused eTLD+1 hosts from local storage. Always returns an array,
 * even when storage has never been written to or holds garbage — the SW
 * shouldn't crash on a hand-edited prefs file.
 */
async function readPausedHosts(): Promise<string[]> {
  const stored = await chrome.storage.local.get([PAUSED_HOSTS_KEY]);
  const raw = stored[PAUSED_HOSTS_KEY];
  if (!Array.isArray(raw)) return [];
  // Filter to strings — defensive against partial/corrupt writes from
  // older versions of the extension.
  return raw.filter((x): x is string => typeof x === 'string');
}

/** Write paused hosts back, normalised: lowercased, deduped, sorted. */
async function writePausedHosts(hosts: string[]): Promise<void> {
  const normalised = Array.from(
    new Set(hosts.map((h) => h.toLowerCase())),
  ).sort();
  await chrome.storage.local.set({ [PAUSED_HOSTS_KEY]: normalised });
}

/**
 * Serialize all pause-rule reconciliations through a single promise chain.
 *
 * We have *two* triggers that both call `reconcilePauseRules`:
 *   1. The message handlers (toggle / resume-all), which await it directly
 *      so they can return fresh state to the popup.
 *   2. The `chrome.storage.onChanged` listener, which fires asynchronously
 *      after every storage write — including the writes the message
 *      handlers themselves perform.
 *
 * Without serialization, those two paths race on every toggle: both call
 * `getSessionRules`, both compute the same `removeRuleIds`, both try to
 * add a rule at id 100000, and one of them throws "duplicate rule id".
 * That rejection propagated up the message handler with no `.catch()` and
 * left the popup's `await send(...)` hanging forever — visible as the
 * pause button getting disabled and never coming back.
 *
 * A queue-of-one is enough: the second call simply waits for the first to
 * finish and then re-reads storage, which by then reflects the latest
 * write. Failures are caught here so they don't poison the queue.
 */
let pauseReconcileQueue: Promise<void> = Promise.resolve();
function reconcilePauseRules(): Promise<void> {
  pauseReconcileQueue = pauseReconcileQueue
    .catch(() => undefined)
    .then(() => doReconcilePauseRules());
  return pauseReconcileQueue;
}

/**
 * Tear down our session rules in the reserved id range and rebuild them
 * from the current paused-hosts list. Always invoked through the
 * `reconcilePauseRules` queue above — never call this directly.
 *
 * Each paused host gets one `allowAllRequests` rule scoped to that host's
 * eTLD+1 via `requestDomains`. Chrome's matcher already treats
 * `requestDomains: ["example.com"]` as "example.com or any subdomain", so
 * one rule covers `www.`, `m.`, `cdn.` etc. without us enumerating.
 *
 * Priority sits above the static-rule ladder (1..4) so it wins all
 * conflicts. `allowAllRequests` extends the allow to the full frame tree
 * once it matches the main_frame request — which is what makes the
 * pause-on-host UX work: the user sees the page as if our extension
 * weren't installed at all.
 */
async function doReconcilePauseRules(): Promise<void> {
  const hosts = await readPausedHosts();

  // Read the current session rules and pick out only the ones in our
  // reserved id range. Any other session rules (future dynamic features)
  // belong to a different subsystem and we leave them alone.
  const existing = await chrome.declarativeNetRequest.getSessionRules();
  const ourIds = existing
    .filter((r) => r.id >= PAUSE_RULE_ID_BASE && r.id <= PAUSE_RULE_ID_MAX)
    .map((r) => r.id);

  // @types/chrome models RuleActionType and ResourceType as real string
  // enums, so plain string literals don't satisfy the type even though
  // they're exactly what Chrome expects on the wire. Two narrow casts
  // here keep the rest of the rule object strictly typed (id/priority/
  // requestDomains stay checked) without the heavier `as Rule[]` shotgun.
  const addRules: chrome.declarativeNetRequest.Rule[] = hosts.map((host, i) => ({
    id: PAUSE_RULE_ID_BASE + i,
    priority: PAUSE_RULE_PRIORITY,
    action: {
      type: 'allowAllRequests' as chrome.declarativeNetRequest.RuleActionType,
    },
    condition: {
      requestDomains: [host],
      // allowAllRequests requires resource type to be one of main_frame /
      // sub_frame. Including both means the allow propagates regardless
      // of whether the user reaches the host via top-level navigation or
      // an iframe.
      resourceTypes: ['main_frame', 'sub_frame'] as chrome.declarativeNetRequest.ResourceType[],
    },
  }));

  if (ourIds.length === 0 && addRules.length === 0) return;
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: ourIds,
    addRules,
  });
  console.debug('[sw] pause rules reconciled', {
    removed: ourIds.length,
    added: addRules.length,
    hosts,
  });
}

/**
 * Toggle pause for a host. Returns the new paused state for that host so
 * the caller (popup) can update its UI without a follow-up read.
 */
async function togglePauseForHost(host: string): Promise<boolean> {
  const lower = host.toLowerCase();
  const hosts = await readPausedHosts();
  const idx = hosts.indexOf(lower);
  if (idx >= 0) {
    hosts.splice(idx, 1);
  } else {
    hosts.push(lower);
  }
  await writePausedHosts(hosts);
  await reconcilePauseRules();
  return idx < 0;
}

/** Clear all paused hosts. Used by the "Resume everywhere" affordance. */
async function clearAllPauses(): Promise<void> {
  await writePausedHosts([]);
  await reconcilePauseRules();
}

// ---------------------------------------------------------------------------
// Lifecycle hooks.
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener((details) => {
  console.debug('[sw] onInstalled', details.reason);
  // Fire-and-forget — no one is awaiting this. Failures log to the SW
  // console; Chrome keeps the extension loaded either way.
  void reconcileRulesets();
  void reconcilePauseRules();
  // Badge styling (colors) is global; the count is per-tab and gets
  // populated for the currently-focused tab here so the user sees a badge
  // immediately after install, not only after their next tab switch.
  void initBadgeStyling().then(() => updateBadgeForActiveTab());
  // Schedule the cosmetic-refresh alarm. setupRefreshAlarm is gated on
  // the user's autoRefresh preference and is idempotent (won't reset an
  // already-running schedule), so it's safe on every onInstalled.
  void setupRefreshAlarm();
});

chrome.runtime.onStartup.addListener(() => {
  console.debug('[sw] onStartup');
  void reconcileRulesets();
  // Session rules are wiped on browser restart; rehydrate from storage
  // so the user's pauses survive across restarts (the `local`-backed
  // pausedHosts list does survive).
  void reconcilePauseRules();
  // Re-apply badge styling — Chrome persists the bg/text color within a
  // session but a browser restart resets them, so we set them again.
  void initBadgeStyling().then(() => updateBadgeForActiveTab());
  // Alarms persist across browser restarts (chrome.alarms is durable),
  // but we still call setupRefreshAlarm here defensively in case the
  // alarm was somehow cleared between sessions or the user toggled
  // autoRefresh while the browser was closed.
  void setupRefreshAlarm();
});

// Cosmetic-refresh alarm fires on schedule (~weekly) and runs the
// fetch/compile/store loop. We re-check the autoRefresh pref inside
// setupRefreshAlarm rather than gating here; that way a quickly-toggled
// preference takes effect on the *next* schedule reconcile rather than
// silently mid-run.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== COSMETIC_REFRESH_ALARM) return;
  console.debug('[sw] cosmetic-refresh alarm fired');
  void runRefresh();
});

// Badge update triggers. Two events are enough to keep the count fresh
// without polling:
//   - onActivated: the user switched tabs, so the badge must reflect the
//     new tab's count rather than the old one.
//   - onUpdated (status === 'complete'): a navigation in any tab finished,
//     which is when getMatchedRules has the most freshly-rotated counts.
//     Filtering on 'complete' avoids a flurry of redundant updates during
//     the loading phase (each subresource fires onUpdated).
//
// Long-tail XHR after page-load won't refresh the badge — opening the
// popup re-queries getMatchedRules directly, so the user always has a
// way to get a fresher number when they care.
chrome.tabs.onActivated.addListener(({ tabId }) => {
  void updateBadgeForTab(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete') {
    void updateBadgeForTab(tabId);
  }
});

// React to options-page changes immediately without waiting for the next
// SW restart. We listen on both areas:
//   - `sync`: where options/index.ts writes per-source enable prefs and
//     the autoRefresh toggle. Source-pref changes drive ruleset reconcile;
//     autoRefresh changes drive the alarm install / clear.
//   - `local`: where pause toggles persist `pausedHosts`. Watching this
//     keeps the SW honest even if a future caller writes to the key
//     without going through `togglePauseForHost` (e.g. an importer).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync') {
    // Per-source enable prefs and the autoRefresh toggle live in `sync`.
    // The reconcileRulesets() pass is unconditional (cheap, only delta-
    // applies) but the alarm setup needs to react specifically to
    // autoRefresh flipping — clearing or re-installing the schedule.
    void reconcileRulesets();
    if (AUTO_REFRESH_KEY in changes) {
      void setupRefreshAlarm();
    }
  } else if (area === 'local' && PAUSED_HOSTS_KEY in changes) {
    void reconcilePauseRules();
  }
});

// ---------------------------------------------------------------------------
// Message router.
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
  // The onMessage callback must `return true` for async responses, which
  // tells Chrome to keep the message port open until sendResponse fires.
  // We return true unconditionally below so every branch stays uniform.
  //
  // CRITICAL: every code path here must end in `sendResponse(...)`. If
  // handleMessage rejects without a catch, sendResponse never fires,
  // Chrome holds the channel open, and the popup's `await send(...)`
  // hangs indefinitely (the user sees the pause button stuck disabled,
  // no UI update, no auto-reload). The catch wrapper is the safety net.
  handleMessage(raw)
    .then(sendResponse)
    .catch((err: unknown) => {
      console.error('[sw] handleMessage threw', err);
      const message =
        err instanceof Error ? err.message : String(err ?? 'unknown error');
      sendResponse({ ok: false, error: message });
    });
  return true;
});

async function handleMessage(raw: unknown): Promise<Response> {
  // Narrow aggressively — the SW is a message-receiver; never trust the
  // input's shape. An errant popup version or a debugger-injected message
  // should fail cleanly, not crash the SW.
  if (!raw || typeof raw !== 'object' || !('type' in raw)) {
    return { ok: false, error: 'malformed message' };
  }
  const msg = raw as Message;
  switch (msg.type) {
    case 'popup:get-state':
      return popupGetState();
    case 'options:reload-rulesets':
      await reconcileRulesets();
      return popupGetState();
    case 'popup:toggle-pause': {
      if (!msg.host) {
        return { ok: false, error: 'toggle-pause requires a non-empty host' };
      }
      await togglePauseForHost(msg.host);
      // Re-derive state after the toggle so the popup's UI reflects truth
      // rather than guessing from its own pre-toggle snapshot.
      return popupGetState();
    }
    case 'popup:resume-all':
      await clearAllPauses();
      return popupGetState();
    default: {
      // Exhaustive-check — if `Message` grows a new variant and this
      // switch isn't updated, TS refuses to compile.
      const _exhaustive: never = msg;
      return { ok: false, error: `unknown message ${JSON.stringify(_exhaustive)}` };
    }
  }
}

async function popupGetState(): Promise<Response> {
  const enabledRulesetIds = await chrome.declarativeNetRequest.getEnabledRulesets();
  const blockedCount = await approximateBlockedCount();
  const currentHost = await currentTabHost();
  const pausedHosts = await readPausedHosts();
  const pausedOnCurrentHost =
    currentHost !== null && pausedHosts.includes(currentHost);
  return {
    ok: true,
    // "Enabled" at the popup level means *any* chunk is active. If every
    // source is disabled the enabled-set is empty and the popup says
    // paused. A partially-enabled source shouldn't happen — the SW only
    // toggles source-granularity — but the read-side is forgiving either
    // way.
    enabled: enabledRulesetIds.length > 0,
    blockedCount,
    enabledRulesetIds,
    currentHost,
    pausedOnCurrentHost,
    pausedHosts,
  };
}

/**
 * Resolve the active tab's URL into an eTLD+1, or `null` if we can't —
 * which covers chrome:// pages, IP addresses, localhost, and any tab the
 * SW can't see (rare, but possible during quick window switches).
 */
async function currentTabHost(): Promise<string | null> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return null;
    return etldPlusOne(tab.url);
  } catch (err) {
    console.debug('[sw] currentTabHost failed', err);
    return null;
  }
}

/**
 * Return the number of blocked requests the user has seen recently. Uses
 * `getMatchedRules` with the active tab as the scope, which requires the
 * `declarativeNetRequestFeedback` permission (already declared in
 * manifest.json).
 *
 * This is an approximation on purpose — Chrome rotates match records on a
 * window of a few minutes, so the number isn't a lifetime counter. Good
 * enough for the popup, which just wants to show the user "yes, this
 * extension is doing something".
 */
async function approximateBlockedCount(): Promise<number> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return 0;
    const { rulesMatchedInfo } = await chrome.declarativeNetRequest.getMatchedRules({
      tabId: tab.id,
    });
    return rulesMatchedInfo.length;
  } catch (err) {
    // getMatchedRules can throw if the active tab is a chrome:// page or
    // if the feedback permission is missing in some Chrome versions. Don't
    // let a count failure break the popup's primary signal.
    console.debug('[sw] approximateBlockedCount failed', err);
    return 0;
  }
}

export {};
