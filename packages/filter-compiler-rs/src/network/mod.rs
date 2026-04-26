//! Network-rule pipeline.
//!
//! Takes a `token::NetworkRule` (raw `pattern` + raw `options` strings from
//! the lexer) and produces a Chrome declarativeNetRequest rule. Split into
//! three submodules so each one has a single job and a small test surface:
//!
//!   - [`options`] — parses the `$...` option string into a typed
//!     [`options::NetworkOptions`] plus a list of diagnostics.
//!   - `dnr` (Phase 2 slice 3) — typed DNR rule/action/condition structs
//!     with `serde::Serialize` tuned to Chrome's exact field names.
//!   - `emit` (Phase 2 slice 4) — combines the parsed pattern + options and
//!     produces a finished `DnrRule` with a stable id + priority.
//!
//! The three are walled off deliberately: the options parser doesn't know
//! DNR exists, and the emitter doesn't know how options got parsed. That
//! keeps unit tests tight and lets us swap the emitter later (e.g. for a
//! Safari content-blocker target) without touching the parser.

pub mod dnr;
pub mod emit;
pub mod options;
