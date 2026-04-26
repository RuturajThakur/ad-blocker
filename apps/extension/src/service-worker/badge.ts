// Action-icon badge for the recent blocked-request count.
//
// We render a tiny per-tab counter on the toolbar icon so the user can tell
// the extension is doing something without opening the popup. The number is
// approximate by design: Chrome's `getMatchedRules` rotates entries on a
// rolling window of a few minutes (no public knob to extend it), so this is
// "recent activity" rather than "lifetime count". That matches how every
// mainstream blocker (uBO, AdGuard, AdBlock) presents it.
//
// Why a separate module? The SW already juggles ruleset reconciliation,
// pause-rule reconciliation, and the message router; piling badge logic
// into the same file made it harder to read. Splitting also gives the
// formatter a clean unit-test target without touching the chrome API
// surface.

import { etldPlusOne } from '../shared/etld.js';
import { PAUSED_HOSTS_KEY } from '../shared/messages.js';

/**
 * Brand colors for the badge. Picked for legibility on both light and dark
 * Chrome themes — Chrome doesn't theme the badge itself, so we set a fixed
 * pair and trust contrast. Blue rather than red because the badge is an
 * informational signal ("activity"), not an alert ("danger").
 */
const BADGE_BG_COLOR = '#3578E5';
const BADGE_TEXT_COLOR = '#FFFFFF';

/**
 * Format a blocked-request count for the badge.
 *
 * Constraints:
 *   - Chrome's badge fits ~4 characters comfortably; we cap at 3 to stay
 *     readable on small icons (e.g. when the toolbar is in compact mode).
 *   - Zero renders as empty so paused / quiet sites don't show a noisy "0".
 *   - Negative inputs are defensive only — the API never returns them, but
 *     guarding here makes the helper safe to feed any number.
 */
export function formatBadgeCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n > 99) return '99+';
  return String(n);
}

/**
 * Apply the global badge styling. Called once on install / startup. Chrome
 * persists these across SW restarts within a session but not across
 * extension reloads, so re-applying on every wake-up keeps the look stable
 * after dev reloads.
 *
 * `setBadgeTextColor` is Chrome 110+. The manifest requires Chrome 120, so
 * we call it unconditionally — no feature detection needed.
 */
export async function initBadgeStyling(): Promise<void> {
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_BG_COLOR });
  await chrome.action.setBadgeTextColor({ color: BADGE_TEXT_COLOR });
}

/**
 * Whether this tab's eTLD+1 is on the user's paused list. Returning `false`
 * on any failure is the right default: the badge will then show the blocked
 * count, which is at worst "noisy" — never "wrong" in a privacy sense.
 */
async function isTabPaused(tab: chrome.tabs.Tab): Promise<boolean> {
  if (!tab.url) return false;
  const host = etldPlusOne(tab.url);
  if (!host) return false;
  try {
    const stored = await chrome.storage.local.get([PAUSED_HOSTS_KEY]);
    const list = stored[PAUSED_HOSTS_KEY];
    if (!Array.isArray(list)) return false;
    return list.includes(host);
  } catch (err) {
    console.debug('[sw] badge: pause-state read failed', err);
    return false;
  }
}

/**
 * Refresh the badge for a single tab. Idempotent — safe to call on every
 * tab event without a debounce. Two outcomes:
 *
 *   - Tab is on a paused host → badge cleared. We deliberately don't show
 *     "0" or "off" text: an empty badge is the cleanest signal that the
 *     extension is intentionally not acting here, and the popup's status
 *     row carries the full explanation when the user wants it.
 *   - Otherwise → badge text is the formatted match count. Even when the
 *     count is zero we still call setBadgeText so a stale "5" from a
 *     previous URL on the same tab gets cleared when the count drops.
 *
 * Failures are swallowed because Chrome's `getMatchedRules` throws on
 * non-http(s) tabs (chrome://, view-source://, etc.) — those tabs can't
 * have a meaningful blocked count anyway, and a thrown error here would
 * leak into the SW log on every tab switch to the new tab page.
 */
export async function updateBadgeForTab(tabId: number): Promise<void> {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (await isTabPaused(tab)) {
      await chrome.action.setBadgeText({ text: '', tabId });
      return;
    }
    const { rulesMatchedInfo } =
      await chrome.declarativeNetRequest.getMatchedRules({ tabId });
    await chrome.action.setBadgeText({
      text: formatBadgeCount(rulesMatchedInfo.length),
      tabId,
    });
  } catch (err) {
    // Swallow — see function comment. Debug-level so it's still visible in
    // the SW DevTools when the developer is hunting weird tab-state bugs.
    console.debug('[sw] updateBadgeForTab failed', { tabId, err });
  }
}

/**
 * Convenience used at install / startup time before any tab event has
 * fired — gives the user an instant badge on the tab they currently have
 * open instead of waiting for the next tab switch.
 */
export async function updateBadgeForActiveTab(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id !== undefined) await updateBadgeForTab(tab.id);
  } catch (err) {
    console.debug('[sw] updateBadgeForActiveTab failed', err);
  }
}
