// Shared message-type contracts between popup/options and the SW.
//
// The content script does NOT talk to the SW for cosmetic rules — it fetches
// the web-accessible per-source `cosmetic-<source>.json` files directly,
// merges them in-memory for whichever sources the user has enabled, and runs
// the matcher locally. Keeping the content script off the message bus avoids
// paying the SW wake-up cost on every page load, which is the hot path.

/** Narrow union of every message the SW can receive. The SW's onMessage
 *  handler switches exhaustively on `type` so adding a new variant is a
 *  compile-time prompt to handle it. */
export type Message =
  | { type: 'popup:get-state' }
  | { type: 'options:reload-rulesets' }
  /** Toggle pause for a specific eTLD+1. Popup is responsible for
   *  resolving the active tab's URL into a host before sending — the SW
   *  doesn't redo that work because it would have to query `tabs` with
   *  the popup's permissions anyway. `null` host should never be sent;
   *  the popup hides the button when it can't derive one. */
  | { type: 'popup:toggle-pause'; host: string }
  /** Clear all paused hosts. "Resume everywhere" affordance. */
  | { type: 'popup:resume-all' };

/** The SW's reply shape. Using a discriminated union on `ok` so callers
 *  have to check it before reading success fields.
 *
 *  `enabledRulesetIds` is the list of Chrome-level *chunk* ids currently
 *  enabled — not source ids. The popup only uses it to test for "any chunk
 *  enabled", so the distinction doesn't matter there, but future callers
 *  should know what they're reading.
 *
 *  `currentHost` is the eTLD+1 of the active tab, or `null` if we
 *  couldn't derive one (chrome:// page, localhost, IP address). The popup
 *  uses it to label the pause button and decide whether to render it. */
export type Response =
  | {
      ok: true;
      enabled: boolean;
      blockedCount: number;
      enabledRulesetIds: string[];
      currentHost: string | null;
      pausedOnCurrentHost: boolean;
      pausedHosts: string[];
    }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Source ↔ chunk namespaces.
//
// Chrome caps static rulesets at 30,000 rules each. Real EasyList /
// EasyPrivacy are well over that, so each user-facing "filter list source"
// is split across multiple Chrome-facing "chunk" rulesets. The options UI
// toggles *sources*; Chrome sees *chunks*. The SW translates between the
// two when reconciling.
//
// The numbers here are declared in two places and *must* agree:
//   - `SOURCE_IDS` + `CHUNKS_PER_SOURCE` below
//   - `declarative_net_request.rule_resources[]` in manifest.json
//
// If they drift, Chrome silently ignores chunks the manifest doesn't
// declare and rejects attempts to enable ids the manifest declares but the
// build script didn't write. Grep for `easylist-3` et al. before touching
// either file.
// ---------------------------------------------------------------------------

/** User-facing filter list sources — one per UI toggle and storage key.
 *
 *  Order matters for two things:
 *    - The options-page checkboxes render in this order.
 *    - The content script fetches per-source cosmetic bundles and merges
 *      them in this order. Dedup is set-based so the visible result is
 *      order-insensitive, but a stable iteration order keeps generated
 *      bundles byte-identical across builds.
 */
export const SOURCE_IDS = [
  'easylist',
  'easyprivacy',
  'easylist-cookie',
  'easylist-annoyances',
] as const;
export type SourceId = (typeof SOURCE_IDS)[number];

/**
 * Whether each source is enabled by default on first install.
 *
 * Policy:
 *   - `easylist` + `easyprivacy`: default ON. Baseline ad + tracker blocks
 *     every user expects from an ad blocker.
 *   - `easylist-cookie` + `easylist-annoyances`: default OFF. Annoyance
 *     lists block more aggressively (cookie banners, "support us by
 *     disabling" walls, newsletter overlays) and have a meaningful
 *     site-breakage rate on e-commerce / news flows. Mainstream blockers
 *     (uBO, AdBlock Plus, AdGuard) ship them off-by-default for the same
 *     reason — users who want them turn them on intentionally.
 *
 * Both the SW and the content script consult this map when storage hasn't
 * yet been written for a key; keeping one source of truth means the two
 * can never disagree about what "default" means.
 */
export const SOURCE_DEFAULTS: Readonly<Record<SourceId, boolean>> = {
  easylist: true,
  easyprivacy: true,
  'easylist-cookie': false,
  'easylist-annoyances': false,
};

/** How many ruleset chunks we pre-declare per source. Sized for ~50%
 *  headroom over the current real-list rule counts (EasyList ~60k,
 *  EasyPrivacy ~55k → 90k budget each). If a list outgrows this, bump the
 *  constant AND add the matching entries to manifest.json. */
export const CHUNKS_PER_SOURCE = 3;

/**
 * Deterministic chunk id for a (source, 1-based index) pair. Exposed as a
 * helper so the SW, build script, and tests all derive ids the same way.
 */
export function chunkId(sourceId: SourceId, index1Based: number): string {
  return `${sourceId}-${index1Based}`;
}

/** All chunk ids currently declared across the manifest. Flat — suitable
 *  for an `updateEnabledRulesets` call argument. */
export const CHUNK_IDS: readonly string[] = SOURCE_IDS.flatMap((id) =>
  Array.from({ length: CHUNKS_PER_SOURCE }, (_, i) => chunkId(id, i + 1)),
);

/** Chunk ids belonging to a single source. Order is stable (1..N). */
export function chunksForSource(sourceId: SourceId): string[] {
  return Array.from({ length: CHUNKS_PER_SOURCE }, (_, i) =>
    chunkId(sourceId, i + 1),
  );
}

// ---------------------------------------------------------------------------
// Pause-on-host storage + session-rule constants.
// ---------------------------------------------------------------------------

/**
 * Key in `chrome.storage.local` holding the array of paused eTLD+1 hosts.
 * Lives in `local`, not `sync`, because pause lists tend to grow over time
 * and `sync` has tight per-key quotas. List-enable prefs (which list is
 * on/off) stay in `sync` for cross-device parity — those are small and
 * stable.
 */
export const PAUSED_HOSTS_KEY = 'pausedHosts';

/**
 * ID range we reserve for our pause session rules. Session rules are a
 * shared namespace within the extension; reserving an explicit range lets
 * the SW remove its own pause rules without disturbing any future
 * dynamic rules another subsystem might add.
 *
 * Sized for far more paused hosts than any realistic user will create.
 * Chrome's `MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES` is 5,000.
 */
export const PAUSE_RULE_ID_BASE = 100_000;
export const PAUSE_RULE_ID_MAX = 199_999;

/**
 * Priority for pause session rules. Must beat every static-rule priority
 * we emit (currently 1..4 — see network/emit.rs's priority ladder).
 * `allowAllRequests` at priority 5 wins all conflicts and applies to the
 * whole frame tree once it matches the main_frame request.
 */
export const PAUSE_RULE_PRIORITY = 5;
