// Tests for the auto-refresh path. We mock the chrome.* surface and the
// wasm-backed compile() — the unit under test is the failure-handling
// policy and the per-source orchestration, both pure logic once the
// dependencies are stubbed.
//
// Three layers:
//   1. `isAutoRefreshEnabled` — preference read, default-on, error
//      fallback.
//   2. `setupRefreshAlarm` — install / clear semantics when the user
//      flips the toggle.
//   3. `runRefresh` — per-source orchestration. The contract we pin:
//        - upstream fetch failure → keep last-known-good (no storage write
//          for that source).
//        - compile produces zero cosmetic selectors → suspicious; refuse
//          to overwrite.
//        - happy path → bundle written, lastRefreshed timestamp updated.
//        - all-fail → no lastRefreshed write (so options-page UI doesn't
//          lie about freshness).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AUTO_REFRESH_KEY,
  COSMETIC_LAST_REFRESHED_KEY,
  COSMETIC_REFRESH_ALARM,
  cosmeticStorageKey,
} from '../shared/messages.js';

// ---------------------------------------------------------------------------
// Mock the wasm-backed compile() before importing refresh.ts.
//
// `vi.mock` is hoisted by Vitest to the top of the module — above any
// `const` or `let` initialization. If we declared `const compileMock = vi.fn()`
// above and referenced it inside the factory, the factory would see
// `undefined` because hoisting moved vi.mock past the initializer.
// `vi.hoisted` is the documented escape hatch: it's hoisted alongside
// vi.mock, so the resulting reference is live by the time the factory
// runs. We control `compileMock`'s return value per-test below.
// ---------------------------------------------------------------------------

const { compileMock } = vi.hoisted(() => ({ compileMock: vi.fn() }));
vi.mock('@ad-blocker/filter-compiler-js/compile-browser', () => ({
  compile: compileMock,
}));

// Vitest hoists vi.mock above all imports, so by the time refresh.js loads
// its `compile-browser` import resolves to the mock module declared above.
import {
  isAutoRefreshEnabled,
  runRefresh,
  setupRefreshAlarm,
} from './refresh.js';

// ---------------------------------------------------------------------------
// chrome.* stubs.
//
// We model just the calls the refresh path uses. Each test gets fresh stubs
// so behavior between cases doesn't bleed.
// ---------------------------------------------------------------------------

interface ChromeStubs {
  syncStore: Record<string, unknown>;
  localStore: Record<string, unknown>;
  alarms: { name: string }[];
  fetchCalls: string[];
  fetchImpl: (url: string) => Response | Promise<Response>;
}

let stubs: ChromeStubs;

function makeChrome(s: ChromeStubs): typeof chrome {
  // Minimal shape — we only stub what refresh.ts touches.
  return {
    storage: {
      sync: {
        get: vi.fn(async (keys: string[]) => {
          const out: Record<string, unknown> = {};
          for (const k of keys) {
            if (k in s.syncStore) out[k] = s.syncStore[k];
          }
          return out;
        }),
      },
      local: {
        get: vi.fn(async (keys: string[]) => {
          const out: Record<string, unknown> = {};
          for (const k of keys) {
            if (k in s.localStore) out[k] = s.localStore[k];
          }
          return out;
        }),
        set: vi.fn(async (entries: Record<string, unknown>) => {
          Object.assign(s.localStore, entries);
        }),
      },
    },
    alarms: {
      get: vi.fn(async (name: string) =>
        s.alarms.find((a) => a.name === name),
      ),
      create: vi.fn(async (name: string, _info: unknown) => {
        // create() with the same name replaces the existing one — we
        // model that by removing then pushing.
        s.alarms = s.alarms.filter((a) => a.name !== name);
        s.alarms.push({ name });
      }),
      clear: vi.fn(async (name: string) => {
        const before = s.alarms.length;
        s.alarms = s.alarms.filter((a) => a.name !== name);
        return before !== s.alarms.length;
      }),
    },
  } as unknown as typeof chrome;
}

beforeEach(() => {
  stubs = {
    syncStore: {},
    localStore: {},
    alarms: [],
    fetchCalls: [],
    fetchImpl: () => new Response('', { status: 500 }),
  };
  vi.stubGlobal('chrome', makeChrome(stubs));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      stubs.fetchCalls.push(url);
      return stubs.fetchImpl(url);
    }),
  );
  compileMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// isAutoRefreshEnabled
// ---------------------------------------------------------------------------

describe('isAutoRefreshEnabled()', () => {
  it('defaults to true when storage has no recorded value', async () => {
    expect(await isAutoRefreshEnabled()).toBe(true);
  });

  it('returns the stored boolean when present', async () => {
    stubs.syncStore[AUTO_REFRESH_KEY] = false;
    expect(await isAutoRefreshEnabled()).toBe(false);
  });

  it('falls back to default on a non-boolean stored value', async () => {
    // Defensive: a corrupted write shouldn't disable refresh by accident.
    stubs.syncStore[AUTO_REFRESH_KEY] = 'no';
    expect(await isAutoRefreshEnabled()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// setupRefreshAlarm
// ---------------------------------------------------------------------------

describe('setupRefreshAlarm()', () => {
  it('clears the alarm when autoRefresh is off', async () => {
    stubs.syncStore[AUTO_REFRESH_KEY] = false;
    stubs.alarms.push({ name: COSMETIC_REFRESH_ALARM });
    await setupRefreshAlarm();
    expect(stubs.alarms.find((a) => a.name === COSMETIC_REFRESH_ALARM)).toBeUndefined();
  });

  it('creates the alarm when autoRefresh is on and none exists', async () => {
    await setupRefreshAlarm();
    expect(stubs.alarms.find((a) => a.name === COSMETIC_REFRESH_ALARM)).toBeDefined();
  });

  it('leaves an already-installed alarm alone (does not reset the schedule)', async () => {
    // Pre-existing alarm — calling setup again must not delete-and-recreate
    // it (that would push the next fire back by the initial delay every
    // time the SW wakes up).
    stubs.alarms.push({ name: COSMETIC_REFRESH_ALARM });
    const createSpy = (chrome.alarms.create as unknown) as ReturnType<typeof vi.fn>;
    await setupRefreshAlarm();
    expect(createSpy).not.toHaveBeenCalled();
    expect(stubs.alarms.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// runRefresh
// ---------------------------------------------------------------------------

/** Minimal CompileReport for tests — only the fields refresh.ts inspects. */
function fakeReport(bundle: {
  generic_hide?: string[];
  domain_hide?: Record<string, string[]>;
  domain_exceptions?: Record<string, string[]>;
}) {
  return {
    version: '0.0.0-test',
    counts: {
      blank: 0,
      comment: 0,
      header: 0,
      network: 0,
      network_exception: 0,
      cosmetic: 0,
      cosmetic_exception: 0,
    },
    dnr_rules: [],
    diagnostics: [],
    cosmetic_bundle: {
      generic_hide: bundle.generic_hide ?? [],
      domain_hide: bundle.domain_hide ?? {},
      domain_exceptions: bundle.domain_exceptions ?? {},
    },
  };
}

describe('runRefresh()', () => {
  it('skips entirely when no sources are enabled', async () => {
    // All four sources flipped off.
    stubs.syncStore = {
      easylist: false,
      easyprivacy: false,
      'easylist-cookie': false,
      'easylist-annoyances': false,
    };
    const out = await runRefresh();
    expect(out).toEqual([]);
    expect(stubs.fetchCalls).toEqual([]);
  });

  it('writes per-source bundles + lastRefreshed on the happy path', async () => {
    stubs.syncStore = { easylist: true, easyprivacy: false };
    stubs.fetchImpl = () => new Response('!! some list body', { status: 200 });
    compileMock.mockResolvedValue(fakeReport({ generic_hide: ['.ad-banner'] }));

    const out = await runRefresh();

    expect(out).toEqual([{ sourceId: 'easylist', ok: true }]);
    expect(stubs.localStore[cosmeticStorageKey('easylist')]).toEqual({
      generic_hide: ['.ad-banner'],
      domain_hide: {},
      domain_exceptions: {},
    });
    expect(typeof stubs.localStore[COSMETIC_LAST_REFRESHED_KEY]).toBe('string');
  });

  it('preserves last-known-good on fetch failure', async () => {
    stubs.syncStore = { easylist: true, easyprivacy: false };
    stubs.localStore[cosmeticStorageKey('easylist')] = {
      generic_hide: ['.previous-good'],
      domain_hide: {},
      domain_exceptions: {},
    };
    stubs.fetchImpl = () => new Response('upstream is on fire', { status: 502 });

    const out = await runRefresh();

    expect(out[0]?.ok).toBe(false);
    // Crucial: storage was NOT overwritten.
    expect(stubs.localStore[cosmeticStorageKey('easylist')]).toEqual({
      generic_hide: ['.previous-good'],
      domain_hide: {},
      domain_exceptions: {},
    });
    // No success → no lastRefreshed bump.
    expect(stubs.localStore[COSMETIC_LAST_REFRESHED_KEY]).toBeUndefined();
  });

  it('refuses to overwrite when compile produces zero cosmetic selectors', async () => {
    // Real lists never produce empty cosmetic output. An empty bundle
    // implies upstream returned garbage that compiled cleanly to nothing.
    // Better to keep the existing bundle than overwrite with empty.
    stubs.syncStore = { easylist: true };
    stubs.localStore[cosmeticStorageKey('easylist')] = {
      generic_hide: ['.previous-good'],
      domain_hide: {},
      domain_exceptions: {},
    };
    stubs.fetchImpl = () => new Response('', { status: 200 });
    compileMock.mockResolvedValue(fakeReport({}));

    const out = await runRefresh();

    expect(out[0]?.ok).toBe(false);
    expect(stubs.localStore[cosmeticStorageKey('easylist')]).toEqual({
      generic_hide: ['.previous-good'],
      domain_hide: {},
      domain_exceptions: {},
    });
  });

  it('processes sources independently — one failure does not poison others', async () => {
    stubs.syncStore = {
      easylist: true,
      easyprivacy: true,
      'easylist-cookie': false,
      'easylist-annoyances': false,
    };
    // Fail easylist's fetch; succeed easyprivacy's.
    stubs.fetchImpl = (url) =>
      url.includes('easylist.txt')
        ? new Response('boom', { status: 500 })
        : new Response('!! body', { status: 200 });
    compileMock.mockResolvedValue(fakeReport({ generic_hide: ['.tracker'] }));

    const out = await runRefresh();
    const okSources = out.filter((o) => o.ok).map((o) => o.sourceId);
    const failedSources = out.filter((o) => !o.ok).map((o) => o.sourceId);

    expect(okSources).toEqual(['easyprivacy']);
    expect(failedSources).toEqual(['easylist']);
    // easyprivacy got written; easylist did not.
    expect(stubs.localStore[cosmeticStorageKey('easyprivacy')]).toBeDefined();
    expect(stubs.localStore[cosmeticStorageKey('easylist')]).toBeUndefined();
    // At least one success → lastRefreshed bumps.
    expect(stubs.localStore[COSMETIC_LAST_REFRESHED_KEY]).toBeDefined();
  });

  it('does not bump lastRefreshed when every source fails', async () => {
    stubs.syncStore = { easylist: true, easyprivacy: true };
    stubs.fetchImpl = () => new Response('', { status: 500 });

    const out = await runRefresh();

    expect(out.every((o) => !o.ok)).toBe(true);
    expect(stubs.localStore[COSMETIC_LAST_REFRESHED_KEY]).toBeUndefined();
  });
});
