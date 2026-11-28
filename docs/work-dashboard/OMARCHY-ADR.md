# ADR: Omarchy Zero-Picker Onboarding, Locked Token Refresh & Shell Plugin Runtime

- **Status**: Proposed (Slice 4 contract companion to [WORK-DASHBOARD-PLAN.md](../WORK-DASHBOARD-PLAN.md))
- **Date**: 2026-11-27
- **Owning repo**: `mindgraph-mcp` (Omarchy desktop integration) with auth contract from `mindgraph-cloud`

## Context

The current `feature/omarchy-desktop` branch implements explicit per-repository linking (`src/desktop-setup.ts`), sibling-only reconnect (`src/session-consent.ts`), static API-key browser connect (`src/browser-connect.ts`), single-default-agent registration (`src/desktop-agent.ts`), and static JSONC menu entries (`src/omarchy-menu.ts`).

The work dashboard plan shifts Omarchy to a zero-picker experience (no Space/Project picker on first use, multi-client setup, revocable device access, and a 6-widget shell plugin) without weakening the privacy and fail-closed guarantees already tested in this repository.

## Decision 1 — Consent & Privacy Reconciliation

1. **Desktop-level recognition replaces interactive Space pickers on new setups.** Signing in and selecting coding applications during first-run onboarding (`desktop welcome` / **Connect**) enables automatic checkout recognition for repositories that are *not* explicitly excluded.
2. **Explicit opt-outs always win before any network lookup.** Before normalizing a Git remote or calling Cloud:
   - Check `MINDGRAPH_HOOKS=off` and eval guards (`src/eval-guard.ts`).
   - Check explicit `mindgraph-mcp off` / workspace exclusions in the consent store (`~/.mindgraph/hooks.json`).
   - Check a user-managed local deny-list (`excludedDirectories` / `excludedRemotes`) so private or client repositories never transmit their Git origin to MindGraph Cloud.
3. **Legacy consent stores migrate cleanly.** Existing pinned repositories and Spaces continue to be honored verbatim; existing exclusions are preserved across upgrades and disconnects.
4. **Non-git folders stay strictly local.** Folders without `.git` are keyed locally (on-device salted hash in `~/.mindgraph/runtime/local-folders.json`, mode `0600`) for local continuity and never transmit raw filesystem paths to Cloud.

## Decision 2 — Non-Interactive Packaging & Multi-Client Onboarding

1. **`PKGBUILD` / `makepkg` stays strictly non-interactive.** No prompts run during Arch package installation.
2. **Client selection moves to first-run onboarding (`desktop welcome` / `desktop setup`).** The prompt asks *"Which coding applications do you use?"* with choices: `Codex`, `Claude Code`, `Both`, or `Dashboard only`.
3. **`src/desktop-agent.ts` configures every selected client** while preserving Omarchy’s default agent preference (`omarchy default agent`) for handoffs. `Dashboard only` skips MCP/hook installation altogether.

## Decision 3 — Multi-Process Locked OAuth PKCE Token Refresh & Disconnect

1. **Staging verification gate first.** Validate `mindgraph-cloud`’s revocable device grant / PKCE flow (scopes, audiences, refresh rotation, self-revocation) before switching `src/browser-connect.ts` off static API keys.
2. **Single file-locked token refresh helper.** Because Claude Code MCP, Codex MCP, session hooks, CLI commands, and the shell plugin run as independent OS processes, refresh-token rotation must never race:
   - Store device grant state in `~/.mindgraph/device-auth.json` (mode `0600`, atomic temp-file + rename).
   - Acquire an advisory exclusive lock (`~/.mindgraph/runtime/token.lock`) before refreshing an expiring access token; re-read the token file after acquiring the lock so waiters reuse the fresh token instead of double-rotating.
3. **Legacy API-key compatibility.** Existing `hooks.json` `apiKey` connections remain functional until the user runs `desktop disconnect` or reconnects via PKCE.
4. **Explicit `desktop disconnect`.** Clears desktop credentials (`apiKey`, `orgId`, device tokens), removes cached desktop widget summaries and hook health markers, attempts best-effort remote grant revocation (falling back to offline disconnect with a pointer to **Connected apps**), and preserves `agentId` plus all explicit repository exclusions.

## Decision 4 — Launcher Statefulness & Shell Plugin IPC

1. **Menu vs. Apps launcher**:
   - `Super + Space` (`~/.config/omarchy/extensions/omarchy-menu.jsonc`): verify Omarchy visibility-predicate syntax backed by local connection state (`signed_out` → **Connect**; `signed_in` → **Dashboard**, **Resume work**, **Disconnect**).
   - Apps launcher: system `.desktop` entries under `/usr/share/applications/` cannot evaluate dynamic predicates. Keep `/usr/share/applications/mindgraph.desktop` as a single state-aware entry (or manage per-user actions under `~/.local/share/applications/` without root privileges).
2. **Shell plugin runtime (no TCP port 18790)**:
   - Run a single user-level background source (native `omarchy-shell` service module or `systemd --user` helper) holding one device-authorized SSE/cursor stream (with polling fallback) and serving all six widgets over a user-private Unix domain socket (`$XDG_RUNTIME_DIR/mindgraph/shell.sock`, mode `0600`) or session D-Bus.
   - On sleep/wake, reconnect from the last cursor (falling back to snapshot resync if expired).
   - On `desktop disconnect`, immediately close the stream, unlink/notify widgets, and wipe cached widget summaries.
   - Enforce blocker interruption deduplication by `(org_id, blocker_id, blocking_episode)` and suppress alerts during quiet mode or when a lane is suspended.

## Exit Criteria to Begin Slice 4 Implementation

- [ ] Staging PKCE device grant + revocation verified against `mindgraph-cloud`.
- [ ] Confirmed `omarchy-menu.jsonc` visibility-predicate schema on a live Omarchy install.
- [ ] Confirmed shell-plugin host interface (`omarchy-shell` module vs. `systemd --user` + Unix socket).
