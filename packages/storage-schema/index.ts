// Typed schema for chrome.storage.sync and chrome.storage.local.
//
// sync: small user prefs that should roam across devices (<=100KB total,
//       <=8KB per key, quota enforced by Chrome).
// local: larger per-profile state — compiled bundles, per-site toggles,
//        stats counters.
//
// Every bump to SCHEMA_VERSION must come with a migration in migrations.ts.

export const SCHEMA_VERSION = 1 as const;

export interface SyncSchema {
  schemaVersion: typeof SCHEMA_VERSION;
  filterLists: {
    easylist: boolean;
    easyprivacy: boolean;
  };
  uiTheme: 'system' | 'light' | 'dark';
}

export interface LocalSchema {
  schemaVersion: typeof SCHEMA_VERSION;
  /** Per-origin enable/disable overrides. Key: registrable domain. */
  siteOverrides: Record<string, { enabled: boolean; updatedAt: number }>;
  /** Rolling blocked-request counter for the popup badge. */
  stats: {
    totalBlocked: number;
    since: number;
  };
}

export const DEFAULT_SYNC: SyncSchema = {
  schemaVersion: SCHEMA_VERSION,
  filterLists: { easylist: true, easyprivacy: true },
  uiTheme: 'system',
};

export const DEFAULT_LOCAL: LocalSchema = {
  schemaVersion: SCHEMA_VERSION,
  siteOverrides: {},
  stats: { totalBlocked: 0, since: Date.now() },
};
