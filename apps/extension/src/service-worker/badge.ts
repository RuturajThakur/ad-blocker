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
 * Badge background colors. Two states, two colors:
 *
 *   - Active (red, #D93025): the extension is blocking on this tab. Red
 *     was chosen for visibility — when an ad blocker is doing its job the
 *     user wants the badge to read at a glance, and red against the
 *     toolbar's neutral background pops harder than a calmer blue.
 *     #D93025 is Chrome's own action red (used for things like the
 *     close button), so it reads as "native" rather than alarming.
 *
 *   - Paused (blue, #3578E5): the extension is intentionally not acting
 *     on this site (the user has paused via the popup). Blue here is the
 *     "muted / informational" signal — same hue we used previously for
 *     the active badge, kept for the paused state because users who saw
 *     the old build will recognize the color even if the meaning shifted.
 *
 * Color in CSS form is what `chrome.action.setBadgeBackgroundColor`
 * accepts (also accepts `[r,g,b,a]`); the hex form is more readable in
 * code review.
 */
const BADGE_BG_ACTIVE = '#D93025';
const BADGE_BG_PAUSED = '#3578E5';
const BADGE_TEXT_COLOR = '#FFFFFF';

/**
 * Text shown on the badge when this tab's host is paused. Three chars
 * fits comfortably under the badge's ~4-char readability limit, and "OFF"
 * is unambiguous in any locale we'd ship to without a real i18n pass.
 *
 * Why we now show text on the paused state at all: previously the badge
 * cleared entirely on paused tabs, which meant the chosen color was
 * never visible (badge bg only paints under text). Showing "OFF" makes
 * the paused color carry actual signal.
 */
const PAUSED_BADGE_TEXT = 'OFF';

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
 * The default color set here is the active red — most tabs are active most
 * of the time, so making active the default is one fewer per-tab call on
 * the hot path. Paused tabs override the bg color in `updateBadgeForTab`.
 *
 * `setBadgeTextColor` is Chrome 110+. The manifest requires Chrome 120, so
 * we call it unconditionally — no feature detection needed.
 */
export async function initBadgeStyling(): Promise<void> {
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_BG_ACTIVE });
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
 *   - Tab is on a paused host → badge bg flips to the paused blue and the
 *     badge shows "OFF". The user gets an unambiguous signal that the
 *     extension is intentionally not acting here. Previously this branch
 *     just cleared the badge text entirely; that left the user unable to
 *     tell "paused" from "active but quiet" at a glance.
 *   - Otherwise → badge bg is the active red, and the text is the
 *     formatted match count. Even when the count is zero we still call
 *     setBadgeText so a stale "5" from a previous URL on the same tab
 *     gets cleared when the count drops.
 *
 * Why we set the bg color per-tab in both branches: chrome.action's
 * per-tab overrides "stick" until cleared explicitly. If we only set the
 * paused color and never re-set the active color, a tab that was once
 * paused would keep showing the blue bg even after the user un-paused
 * (until SW restart re-runs initBadgeStyling). Setting the right color
 * every call keeps state consistent.
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
      await chrome.action.setBadgeBackgroundColor({
        color: BADGE_BG_PAUSED,
        tabId,
      });
      await chrome.action.setBadgeText({ text: PAUSED_BADGE_TEXT, tabId });
      return;
    }
    await chrome.action.setBadgeBackgroundColor({
      color: BADGE_BG_ACTIVE,
      tabId,
    });
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
