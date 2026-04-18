// Shared message-type contracts between popup/options/content and the SW.
// Keep all string literals narrow so the router stays exhaustively typed.

export type Message =
  | { type: 'popup:get-state' }
  | { type: 'cs:request-cosmetics' }
  | { type: 'options:reload-rulesets' };

export type Response =
  | { ok: true; echoed?: unknown; enabled?: boolean; blockedCount?: number }
  | { ok: false; error: string };
