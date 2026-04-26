// Auto-refresh path — keeps cosmetic bundles current without an extension
// update. Slice 5.5.
//
// Lifecycle:
//   1. SW's `onInstalled` / `onStartup` calls `setupRefreshAlarm()` (gated
//      on the user's `autoRefresh` pref).
//   2. `chrome.alarms` fires `cosmetic-refresh` ~weekly. The SW's
//      `onAlarm` listener routes that to `runRefresh()`.
//   3. `runRefresh()` reads which sources the user has enabled, fetches
//      each upstream `.txt`, compiles via the wasm pipeline, writes the
//      fresh cosmetic bundle to `chrome.storage.local`. Per-source writes
//      are independent — a 502 on one source doesn't poison the others.
//   4. Content script reads `chrome.storage.local` first; on miss, falls
//      back to the bundled `assets/cosmetic-<id>.json`.
//
// What we deliberately do NOT auto-refresh:
//   - DNR network rules. Chrome's 5,000-rule cap on dynamic+session rules
//     is two orders of magnitude smaller than our ~120k static budget,
//     so refreshing the network side in MV3 isn't viable. Network rules
//     ship as-of-build-time and only update on extension update. This is
//     a stated limitation, not a regression — it matches what every other
//     mainstream MV3 blocker has settled on.
//   - The user's per-source enable prefs. Those live in `chrome.storage.sync`
//     and are independent of refresh state.
//
// Failure policy:
//   - Fetch error → keep existing storage value (don't blow away
//     last-known-good with nothing).
//   - Compile produces 0 cosmetic selectors → suspicious (real lists
//     never produce zero cosmetic output); refuse to overwrite.
//   - Per-source independent: only a successful end-to-end pass writes
//     to that source's key. The global `lastRefreshed` timestamp updates
//     only when at least one source refreshed successfully — otherwise
//     options-page UI would lie about freshness.

import { compile } from '@ad-blocker/filter-compiler-js/compile-browser';

import {
  AUTO_REFRESH_DEFAULT,
  AUTO_REFRESH_KEY,
  COSMETIC_LAST_REFRESHED_KEY,
  COSMETIC_REFRESH_ALARM,
  COSMETIC_REFRESH_INITIAL_DELAY_MIN,
  COSMETIC_REFRESH_PERIOD_MIN,
  SOURCE_DEFAULTS,
  SOURCE_IDS,
  SOURCE_UPSTREAM_URLS,
  cosmeticStorageKey,
  type SourceId,
} from '../shared/messages.js';

import type { CosmeticBundle } from '@ad-blocker/filter-compiler-js/compile-browser';

// ---------------------------------------------------------------------------
// User preference: is auto-refresh enabled?
// ---------------------------------------------------------------------------

/**
 * Read the auto-refresh preference, defaulting to on. Same fallback policy
 * as the per-source enable prefs (`SOURCE_DEFAULTS`): if `chrome.storage.sync`
 * has no recorded value, treat as the documented default.
 *
 * Defensive `try/catch` because `storage.sync.get` can throw under quota
 * pressure, and a sync-storage failure should never break the refresh
 * path's overall flow — we'd rather skip refresh than panic the SW.
 */
export async function isAutoRefreshEnabled(): Promise<boolean> {
  try {
    const stored = await chrome.storage.sync.get([AUTO_REFRESH_KEY]);
    const v = stored[AUTO_REFRESH_KEY];
    return typeof v === 'boolean' ? v : AUTO_REFRESH_DEFAULT;
  } catch (err) {
    console.debug('[refresh] autoRefresh pref read failed', err);
    return AUTO_REFRESH_DEFAULT;
  }
}

/**
 * Read which filter sources the user has enabled. Mirrors `readSourcePrefs`
 * in the SW's index.ts — duplicated rather than imported because circular
 * imports between `index.ts` and `refresh.ts` would otherwise tie the
 * module graph in a knot.
 */
async function readEnabledSources(): Promise<SourceId[]> {
  try {
    const stored = await chrome.storage.sync.get([...SOURCE_IDS]);
    return SOURCE_IDS.filter((id) =>
      typeof stored[id] === 'boolean'
        ? (stored[id] as boolean)
        : SOURCE_DEFAULTS[id],
    );
  } catch (err) {
    console.debug('[refresh] enabled-sources read failed', err);
    return SOURCE_IDS.filter((id) => SOURCE_DEFAULTS[id]);
  }
}

// ---------------------------------------------------------------------------
// Alarm management.
// ---------------------------------------------------------------------------

/**
 * Install the recurring alarm if not already present, or clear it if the
 * user has disabled auto-refresh. Idempotent — calling repeatedly is fine
 * (chrome.alarms.create with the same name replaces the existing schedule).
 *
 * Why we always check the existing alarm before creating: on first install
 * we want a one-hour delay before the first fire (user just installed; no
 * point hammering immediately). Re-creating on every SW wake-up would
 * reset that delay window every time — over a long uptime that means the
 * alarm never fires. Reading first and only creating when absent preserves
 * the original schedule.
 */
export async function setupRefreshAlarm(): Promise<void> {
  const enabled = await isAutoRefreshEnabled();
  if (!enabled) {
    await chrome.alarms.clear(COSMETIC_REFRESH_ALARM);
    console.debug('[refresh] alarm cleared (autoRefresh = off)');
    return;
  }
  const existing = await chrome.alarms.get(COSMETIC_REFRESH_ALARM);
  if (existing) {
    // Already scheduled. Don't reset — that would defer the next fire.
    return;
  }
  await chrome.alarms.create(COSMETIC_REFRESH_ALARM, {
    delayInMinutes: COSMETIC_REFRESH_INITIAL_DELAY_MIN,
    periodInMinutes: COSMETIC_REFRESH_PERIOD_MIN,
  });
  console.debug('[refresh] alarm installed', {
    firstFireMinutes: COSMETIC_REFRESH_INITIAL_DELAY_MIN,
    periodMinutes: COSMETIC_REFRESH_PERIOD_MIN,
  });
}

// ---------------------------------------------------------------------------
// Refresh execution.
// ---------------------------------------------------------------------------

/** Result of refreshing a single source. */
type SourceRefreshOutcome =
  | { sourceId: SourceId; ok: true }
  | { sourceId: SourceId; ok: false; reason: string };

/**
 * Fetch an upstream filter list. Throws on non-2xx so the caller can wrap
 * with their own error handling — we don't want the refresh path swallowing
 * "easylist.to is 502'ing" as if it were success.
 *
 * The MUST-BE-HTTPS check is defensive: the URL table in `messages.ts` is
 * already HTTPS-only, but a future maintainer adding a new source might
 * paste an http URL. Refusing here prevents an MITM from injecting
 * arbitrary cosmetic selectors into every install.
 */
async function fetchSourceText(url: string): Promise<string> {
  if (!url.startsWith('https://')) {
    throw new Error(`refusing to fetch non-https url: ${url}`);
  }
  const res = await fetch(url, {
    // `cache: 'no-cache'` doesn't disable caching; it forces revalidation
    // (If-Modified-Since / If-None-Match) which is exactly what we want
    // here — upstream serves ETags, and a 304 round-trip is much cheaper
    // than re-downloading 2 MB.
    cache: 'no-cache',
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  }
  return res.text();
}

/**
 * Refresh one source. Encapsulates the fetch + compile + store sequence
 * for a single list. Returns an outcome rather than throwing so the
 * top-level loop can record per-source results without a try/catch ladder.
 */
async function refreshOneSource(
  sourceId: SourceId,
): Promise<SourceRefreshOutcome> {
  const url = SOURCE_UPSTREAM_URLS[sourceId];
  let text: string;
  try {
    text = await fetchSourceText(url);
  } catch (err) {
    return {
      sourceId,
      ok: false,
      reason: `fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let bundle: CosmeticBundle;
  try {
    const report = await compile(text);
    bundle = report.cosmetic_bundle;
  } catch (err) {
    return {
      sourceId,
      ok: false,
      reason: `compile failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Sanity check — every real list in our set produces at least *some*
  // cosmetic selectors. A zero-output bundle suggests upstream returned a
  // garbage body (HTML error page rendered as text/plain, partial download,
  // etc.). Better to keep the existing bundle than overwrite with empty.
  const hasSelectors =
    bundle.generic_hide.length > 0 ||
    Object.keys(bundle.domain_hide).length > 0 ||
    Object.keys(bundle.domain_exceptions).length > 0;
  if (!hasSelectors) {
    return {
      sourceId,
      ok: false,
      reason: 'compile produced zero cosmetic selectors (suspicious; not overwriting)',
    };
  }

  try {
    await chrome.storage.local.set({ [cosmeticStorageKey(sourceId)]: bundle });
  } catch (err) {
    return {
      sourceId,
      ok: false,
      reason: `storage write failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { sourceId, ok: true };
}

/**
 * Run a full refresh pass. Refreshes only sources the user currently has
 * enabled — no point fetching + compiling + storing a 2 MB list whose DNR
 * rulesets are also disabled.
 *
 * Returns the per-source outcomes for inspection by tests / future telemetry.
 * The caller-visible side effects are storage writes plus an updated
 * `lastRefreshed` timestamp on at least one success.
 */
export async function runRefresh(): Promise<SourceRefreshOutcome[]> {
  const enabled = await readEnabledSources();
  if (enabled.length === 0) {
    console.debug('[refresh] no sources enabled; skipping');
    return [];
  }

  // Run refreshes serially. Concurrency would be slightly faster on the
  // wall clock but each compile is CPU-heavy (tens of ms; see
  // packages/filter-compiler-rs/benches/compile_bench.rs) and running
  // multiple in parallel inside the SW could tie up the event loop long
  // enough to delay other SW responsibilities (popup messages, badge
  // updates). Serial is the politer choice for a background task.
  const outcomes: SourceRefreshOutcome[] = [];
  for (const id of enabled) {
    const outcome = await refreshOneSource(id);
    outcomes.push(outcome);
    if (outcome.ok) {
      console.debug('[refresh] source ok', id);
    } else {
      console.warn('[refresh] source failed', id, outcome.reason);
    }
  }

  // Bump the global timestamp only if at least one source actually
  // succeeded. If everything failed, the existing timestamp is a more
  // honest signal of "freshness" than a "we tried" timestamp would be.
  const anyOk = outcomes.some((o) => o.ok);
  if (anyOk) {
    try {
      await chrome.storage.local.set({
        [COSMETIC_LAST_REFRESHED_KEY]: new Date().toISOString(),
      });
    } catch (err) {
      console.debug('[refresh] lastRefreshed write failed', err);
    }
  }

  return outcomes;
}
