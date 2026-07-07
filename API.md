# Linux Update Dashboard API

All API routes are served below `/api` and return JSON unless a route explicitly redirects, upgrades to WebSocket, or returns an attachment-style JSON export. The browser UI authenticates with an HTTP-only session cookie; external consumers can use bearer API tokens where allowed.

All HTTP endpoints require authentication unless noted. `GET /api/health` bypasses auth only for loopback requests, which is used by the Docker health check. Auth setup/login routes are intentionally public so first-run setup and login can work.

State-changing browser requests are protected by CSRF middleware. Bearer token requests are stateless and do not use CSRF, but tokens cannot access management endpoints.

## API Tokens

Create and manage tokens from **Settings > API Tokens**.

- Permission levels: read-only (`GET`, `HEAD`, `OPTIONS`) or read/write.
- Expiry options: 30, 60, 90, 365 days, or never.
- Storage: only the SHA-256 token hash is stored; the plain token is shown once.
- Limit: 25 tokens per user.
- Scope: tokens cannot access `/api/auth`, `/api/settings`, `/api/tokens`, `/api/passkeys`, `/api/notifications`, `/api/schedules`, `/api/scripts`, or `/api/credentials`.
- SSH safety: tokens are also blocked from configuring SSH connections or script overrides.
- Rate limit: failed bearer attempts are limited to 20/min per IP.

Example:

```bash
curl -H "Authorization: Bearer ludash_..." http://localhost:3001/api/dashboard/stats
```

## Health

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/api/health` | Health check. Loopback requests do not require auth; external requests do. |

## Auth

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/api/auth/status` | Auth state, setup status, and OIDC availability. |
| POST | `/api/auth/setup` | Create the initial admin account. |
| POST | `/api/auth/login` | Password login. |
| POST | `/api/auth/logout` | Clear the current session. |
| GET | `/api/auth/me` | Current user info. |
| POST | `/api/auth/change-password` | Change the current user's password. |
| POST | `/api/auth/totp/setup` | Start TOTP setup for the password-authenticated user. |
| POST | `/api/auth/totp/enable` | Verify a TOTP code and enable authenticator-code sign-in. |
| DELETE | `/api/auth/totp` | Disable TOTP after confirming the current password. |
| POST | `/api/auth/webauthn/register/options` | Start passkey registration. |
| POST | `/api/auth/webauthn/register/verify` | Complete passkey registration. |
| POST | `/api/auth/webauthn/login/options` | Start passkey login. |
| POST | `/api/auth/webauthn/login/verify` | Complete passkey login. |
| GET | `/api/auth/oidc/login` | Redirect to the configured OIDC provider. |
| GET | `/api/auth/oidc/callback` | OIDC callback handler. |

## Dashboard and Settings

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/api/dashboard/stats` | Summary statistics. |
| GET | `/api/dashboard/systems` | Systems with dashboard status metadata. |
| GET | `/api/settings` | Current settings. |
| PUT | `/api/settings` | Update settings. |

## Systems

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/api/systems` | List systems with update counts. Supports `?scope=visible`. |
| GET | `/api/systems/:id` | System detail with updates, installed packages, issues, history, and command reference. |
| POST | `/api/systems` | Add a system. API tokens cannot use this route. |
| PUT | `/api/systems/reorder` | Reorder systems. |
| PUT | `/api/systems/upgrade-order` | Reorder the default Upgrade All system order. |
| PUT | `/api/systems/:id` | Update system configuration. API tokens cannot use this route. |
| PUT | `/api/systems/:id/upgrade-mode` | Toggle the system's default full-upgrade/aggressive upgrade behavior where supported. |
| PUT | `/api/systems/:id/upgrade-all-exclusion` | Include or exclude a system from Upgrade All by default. |
| POST | `/api/systems/test-connection` | Test SSH connectivity, host-key trust, and package-manager detection for a proposed config. API tokens cannot use this route. |
| POST | `/api/systems/:id/reboot` | Reboot a system. |
| POST | `/api/systems/:id/dismiss-needs-reboot` | Dismiss a stale reboot-needed indicator. |
| POST | `/api/systems/:id/dismiss-root-user-banner` | Dismiss the root-user info banner. |
| POST | `/api/systems/:id/dismiss-os-lifecycle-warning` | Dismiss the current OS lifecycle warning snapshot. |
| POST | `/api/systems/:id/revoke-host-key` | Clear the stored trusted host key. |
| PUT | `/api/systems/:id/script-overrides` | Update per-system script overrides. API tokens cannot use this route. |
| DELETE | `/api/systems/:id` | Remove a system. |
| GET | `/api/systems/:id/sudoers-preview` | Generate least-privilege sudoers setup instructions. |
| GET | `/api/systems/:id/updates` | Cached updates for a system. |
| GET | `/api/systems/:id/history` | Activity/history records for a system. |
| POST | `/api/systems/:id/hidden-updates` | Hide one visible update from counts and dashboards. |
| DELETE | `/api/systems/:id/hidden-updates/:hiddenUpdateId` | Unhide an update. |
| POST | `/api/systems/:id/package-issues/:issueId/dismiss` | Dismiss a visible package-manager issue. |

## Upgrade Groups

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/api/systems/upgrade-groups` | List saved Upgrade All groups and the Ungrouped position. |
| POST | `/api/systems/upgrade-groups` | Create an Upgrade All group. |
| PUT | `/api/systems/upgrade-groups/reorder` | Reorder Upgrade All groups and Ungrouped. |
| PUT | `/api/systems/upgrade-groups/systems` | Move systems between Upgrade All groups and set per-group order. |
| PUT | `/api/systems/upgrade-groups/:id` | Rename an Upgrade All group. |
| DELETE | `/api/systems/upgrade-groups/:id` | Delete an Upgrade All group. |

## Updates and Jobs

Long-running update routes usually return a job ID. Poll `GET /api/jobs/:id` for status until it returns `done` or `failed`.

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/api/jobs/:id` | Poll background job status. Completed/failed jobs are kept briefly. |
| POST | `/api/systems/:id/check` | Check one system for updates. |
| POST | `/api/systems/:id/cancel` | Request cancellation of the running operation on a system. |
| POST | `/api/systems/:id/package-issues/:issueId/solve` | Run the repair action for a package-manager issue. |
| POST | `/api/systems/check-all` | Check all systems in the background. |
| POST | `/api/systems/upgrade-all` | Queue an Upgrade All batch for selected systems. |
| POST | `/api/systems/:id/upgrade` | Upgrade all visible packages on a system. |
| POST | `/api/systems/:id/full-upgrade` | Full/dist upgrade on a supported system. |
| POST | `/api/systems/:id/autoremove` | Remove unused packages or runtimes on a supported system. |
| POST | `/api/systems/:id/upgrade-packages` | Upgrade one or more selected visible packages on a system. |
| POST | `/api/systems/:id/upgrade/:packageName` | Compatibility alias for upgrading one selected package. |
| POST | `/api/cache/refresh` | Invalidate cache and re-check all systems. |

## Notifications

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/api/notifications` | List all notification channels. |
| PUT | `/api/notifications/reorder` | Reorder notification channels. |
| GET | `/api/notifications/:id` | Get a notification channel. |
| POST | `/api/notifications` | Create a notification channel. |
| PUT | `/api/notifications/:id` | Update a notification channel. |
| DELETE | `/api/notifications/:id` | Delete a notification channel. |
| POST | `/api/notifications/:id/telegram/link` | Create a one-time Telegram chat binding link. |
| POST | `/api/notifications/:id/telegram/unlink` | Remove Telegram chat binding and revoke any generated command token. |
| POST | `/api/notifications/:id/telegram/reissue-command-token` | Rotate the Telegram command token for a linked channel with commands enabled. |
| POST | `/api/notifications/:id/reset-update-dedupe` | Reset update notification deduplication for a channel. |
| POST | `/api/notifications/test` | Test a notification config inline before saving. |
| POST | `/api/notifications/:id/test` | Send a test notification for a saved channel. |

## Schedules

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/api/schedules` | List schedules. |
| PUT | `/api/schedules/reorder` | Reorder schedules. |
| GET | `/api/schedules/:id` | Get a schedule. |
| POST | `/api/schedules` | Create a schedule. |
| PUT | `/api/schedules/:id` | Update a schedule. |
| DELETE | `/api/schedules/:id` | Delete a schedule. |

## Scripts

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/api/scripts` | List built-in and custom scripts, package-manager definitions, and placeholder help. |
| POST | `/api/scripts` | Create a custom script. |
| PUT | `/api/scripts/:id` | Update a custom script. |
| DELETE | `/api/scripts/:id` | Delete an unused custom script. |
| POST | `/api/scripts/package-managers` | Create a custom package-manager definition. |
| GET | `/api/scripts/package-managers/:name/export` | Export a custom package-manager bundle. |
| POST | `/api/scripts/package-managers/import` | Import a custom package-manager bundle. |
| PUT | `/api/scripts/package-managers/:name` | Update package-manager metadata, parser settings, and custom config entries. |
| DELETE | `/api/scripts/package-managers/:name` | Delete an unused custom package-manager definition. Optional body: `{ "deleteScripts": true }`. |
| POST | `/api/scripts/validate-parser` | Test custom parser settings against sample command output. |
| POST | `/api/scripts/format` | Format a shell command for display/editing. |

## Credentials

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/api/credentials` | List saved SSH credentials. |
| PUT | `/api/credentials/reorder` | Reorder credentials. |
| GET | `/api/credentials/:id` | Get a credential with masked secrets. |
| POST | `/api/credentials` | Create a credential. |
| PUT | `/api/credentials/:id` | Update a credential. |
| DELETE | `/api/credentials/:id` | Delete a credential. |

## Passkeys

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/api/passkeys` | List passkeys for the authenticated user. |
| PATCH | `/api/passkeys/:id` | Rename a passkey. |
| DELETE | `/api/passkeys/:id` | Remove a passkey. |

## API Token Management

These routes manage API tokens and cannot be called with API tokens.

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/api/tokens` | List tokens for the authenticated user. |
| POST | `/api/tokens` | Create a token with `name`, `expiresInDays`, and `readOnly`. |
| PATCH | `/api/tokens/:id` | Rename a token. |
| DELETE | `/api/tokens/:id` | Revoke a token. |

## WebSocket

| Endpoint | Description |
| --- | --- |
| `/api/ws/systems/:id/output` | Live command output stream for one system. Auth is checked during the HTTP upgrade request. |
