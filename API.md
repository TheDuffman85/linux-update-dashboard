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

| Method | Endpoint      | Description                                                                |
| ------ | ------------- | -------------------------------------------------------------------------- |
| GET    | `/api/health` | Health check. Loopback requests do not require auth; external requests do. |

## Auth

| Method | Endpoint                              | Description                                                                        |
| ------ | ------------------------------------- | ---------------------------------------------------------------------------------- |
| GET    | `/api/auth/status`                    | Auth state, setup status, and OIDC availability.                                   |
| POST   | `/api/auth/setup`                     | Create the initial admin account.                                                  |
| POST   | `/api/auth/login`                     | Password login.                                                                    |
| POST   | `/api/auth/logout`                    | Clear the current session. SSO sessions may return a provider `redirectUrl`.       |
| GET    | `/api/auth/me`                        | Current user info.                                                                 |
| POST   | `/api/auth/change-password`           | Change the current user's password.                                                |
| POST   | `/api/auth/totp/setup`                | Start TOTP setup for the password-authenticated user.                             |
| POST   | `/api/auth/totp/enable`               | Verify a TOTP code and enable authenticator-code sign-in.                         |
| DELETE | `/api/auth/totp`                      | Disable TOTP after confirming the current password.                                |
| POST   | `/api/auth/webauthn/register/options` | Start passkey registration.                                                        |
| POST   | `/api/auth/webauthn/register/verify`  | Complete passkey registration.                                                     |
| POST   | `/api/auth/webauthn/login/options`    | Start passkey login.                                                               |
| POST   | `/api/auth/webauthn/login/verify`     | Complete passkey login.                                                            |
| GET    | `/api/auth/oidc/login`                | Redirect to the configured OIDC provider.                                          |
| GET    | `/api/auth/oidc/callback`             | OIDC callback handler.                                                             |

## Dashboard and Settings

| Method | Endpoint                           | Description                                                                   |
| ------ | ---------------------------------- | ----------------------------------------------------------------------------- |
| GET    | `/api/dashboard/stats`             | Summary statistics.                                                           |
| GET    | `/api/dashboard/systems`           | Systems with dashboard status metadata.                                       |
| GET    | `/api/app-update`                  | Application update status.                                                    |
| GET    | `/api/settings`                    | Current settings.                                                             |
| PUT    | `/api/settings`                    | Update settings, including the `app_name` branding setting.                   |
| GET    | `/api/settings/public`             | Unauthenticated language and branding (name, logo URLs, and colors).          |
| GET    | `/api/settings/public/logo`        | Unauthenticated custom logo image; `404` when none is configured.             |
| GET    | `/api/settings/public/logo/dark`   | Unauthenticated dark mode logo image; `404` when none is configured.          |
| PUT    | `/api/settings/branding/logo`      | Upload a custom logo as `{ "dataUrl": "data:image/...;base64,..." }`.         |
| DELETE | `/api/settings/branding/logo`      | Restore the default logo.                                                     |
| PUT    | `/api/settings/branding/logo/dark` | Upload a logo used while the dark theme is active, as `{ "dataUrl": "..." }`. |
| DELETE | `/api/settings/branding/logo/dark` | Remove the dark mode logo so the main logo is used in both themes.            |
| PUT    | `/api/settings/branding/theme`     | Set the colors as `{ "theme": { "light": {...}, "dark": {...} } }`.           |

`GET /api/settings` also returns `managedSettings`, which maps each setting
pinned by an environment variable to that variable's name (for example
`{ "oidc_issuer": "LUDASH_OIDC_ISSUER" }`), and `passwordLoginFallback`, which
is `true` while password login was set to disabled but stays enabled because
neither OIDC nor a passkey is configured. Managed settings report their
effective value. A `PUT /api/settings` that includes a managed key is rejected
with `409` and `{ "code": "MANAGED_BY_CONFIG", "keys": [...] }`, and nothing in
that request is saved.

Custom logos may be PNG, JPEG, GIF, WebP, or SVG images up to 512 KB. The
image type is detected from the file content, and SVG logos are served with a
sandboxed Content Security Policy. Like all `/api/settings` management
endpoints, the branding endpoints are not available to API tokens.

`branding` in `GET /api/settings/public` is
`{ "appName", "logoUrl", "logoDarkUrl", "theme" }`. `logoUrl` is `null` when
the default logo is used, and `logoDarkUrl` is `null` when no dark mode logo is
set. The dark mode logo only replaces the logo in the UI; the favicon,
notifications, and the Telegram bot photo keep using the main logo.

`theme` has a `light` and a `dark` entry, each with an `accent` and a
`neutral` value, for example
`{ "light": { "accent": "#e11d48", "neutral": "zinc" }, "dark": { "accent": null, "neutral": null } }`.
`accent` is a `#rrggbb` (or `#rgb`) color from which the full accent palette is
generated, and `neutral` is one of `slate`, `gray`, `zinc`, `neutral`, or
`stone`. `null` uses the default; in `dark`, `null` uses the `light` setting
instead. Sending all values as `null` restores the default colors.

`GET /api/app-update` is available to read-only and read/write API tokens. It
returns the current version and branch, the latest remote version, whether an
update is available, and release/repository URLs when available.

## Systems

| Method | Endpoint                                           | Description                                                                                                                   |
| ------ | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/systems`                                     | List systems with update counts. Supports `?scope=visible`.                                                                   |
| GET    | `/api/systems/:id`                                 | System detail with updates, installed packages, issues, history, and command reference.                                       |
| POST   | `/api/systems`                                     | Add a system. API tokens cannot use this route.                                                                               |
| PUT    | `/api/systems/reorder`                             | Reorder systems.                                                                                                              |
| PUT    | `/api/systems/:id`                                 | Update system configuration. API tokens cannot use this route.                                                                |
| PUT    | `/api/systems/:id/upgrade-mode`                    | Toggle the system's default full-upgrade/aggressive upgrade behavior where supported.                                         |
| PUT    | `/api/systems/:id/update-priority`                 | Set the system's Upgrade All priority (0–99) within its dashboard group.                                                       |
| PUT    | `/api/systems/:id/upgrade-all-exclusion`           | Set whether a system is preselected for Upgrade All by default (using the inverse `excluded` flag).                            |
| POST   | `/api/systems/test-connection`                     | Test SSH connectivity, host-key trust, and package-manager detection for a proposed config. API tokens cannot use this route. |
| POST   | `/api/systems/:id/reboot`                          | Reboot a system.                                                                                                              |
| POST   | `/api/systems/:id/dismiss-needs-reboot`            | Dismiss a stale reboot-needed indicator.                                                                                      |
| POST   | `/api/systems/:id/dismiss-root-user-banner`        | Dismiss the root-user info banner.                                                                                            |
| POST   | `/api/systems/:id/dismiss-os-lifecycle-warning`    | Dismiss the current OS lifecycle warning snapshot.                                                                            |
| POST   | `/api/systems/:id/revoke-host-key`                 | Clear the stored trusted host key.                                                                                            |
| PUT    | `/api/systems/:id/script-overrides`                | Update per-system script overrides. API tokens cannot use this route.                                                         |
| DELETE | `/api/systems/:id`                                 | Remove a system.                                                                                                              |
| GET    | `/api/systems/:id/sudoers-preview`                 | Generate least-privilege sudoers setup instructions.                                                                          |
| GET    | `/api/systems/:id/repository-sources`              | Read the repository source files of the active package managers over SSH (credentials masked). Each file includes `sha256`, `editable`, and `editBlockedReason`; returns `502` when the host cannot be read. |
| PUT    | `/api/systems/:id/repository-sources`              | Replace one repository source file with `{ path, content, baseSha256, dryRun? }`. Requires **Allow repository source editing** on the system (`repositorySourceEditingEnabled` when creating or updating the system, default off); not available to API tokens. `dryRun` returns the diff without writing. Returns `409` when the file changed on the host or an operation is running, `400` with `line` for invalid syntax. |
| GET    | `/api/systems/:id/updates`                         | Cached updates for a system.                                                                                                  |
| GET    | `/api/systems/:id/history`                         | Activity/history records for a system.                                                                                        |
| POST   | `/api/systems/:id/hidden-updates`                  | Hide one visible update from counts and dashboards.                                                                           |
| DELETE | `/api/systems/:id/hidden-updates/:hiddenUpdateId`  | Unhide an update.                                                                                                             |
| POST   | `/api/systems/:id/package-issues/:issueId/dismiss` | Dismiss a visible package-manager issue.                                                                                      |

`POST /api/systems` and `PUT /api/systems/:id` accept `pkgManagerSecretRefs`, which
assigns secret credentials to secret config entries:
`{ "deb-get": { "githubToken": 12 } }`. Each ID must reference a credential of
kind `secret`. Send `{}` to clear all assignments, or omit the field to keep the
current ones. Plaintext values for secret entries are rejected in
`pkgManagerConfigs`. System responses include `pkgManagerSecretRefs` as
credential IDs only.

## Dashboard Groups

| Method | Endpoint                                  | Description                                                        |
| ------ | ----------------------------------------- | ------------------------------------------------------------------ |
| GET    | `/api/systems/dashboard-groups`           | Return dashboard groups plus the saved Ungrouped position and update priority. |
| POST   | `/api/systems/dashboard-groups`           | Create a dashboard organization group.                            |
| PUT    | `/api/systems/dashboard-groups/reorder`  | Reorder with `{ groupKeys: [number..., "ungrouped"] }`; every group and Ungrouped must appear exactly once. |
| PUT    | `/api/systems/dashboard-groups/systems`  | Assign systems to groups and persist their dashboard card order.  |
| PUT    | `/api/systems/dashboard-groups/update-priority` | Set a saved group or Ungrouped upgrade priority (0–99) with `{ groupId: number | null, updatePriority: integer }`; lower priorities run first and equal priorities run in parallel. |
| PUT    | `/api/systems/dashboard-groups/:id`      | Rename a dashboard organization group.                            |
| DELETE | `/api/systems/dashboard-groups/:id`      | Delete a group and move its systems to Ungrouped.                 |

## Updates and Jobs

Long-running update routes usually return a job ID. Poll `GET /api/jobs/:id` for status until it returns `done` or `failed`.

| Method | Endpoint                                         | Description                                                         |
| ------ | ------------------------------------------------ | ------------------------------------------------------------------- |
| GET    | `/api/jobs/:id`                                  | Poll background job status. Completed/failed jobs are kept briefly. |
| POST   | `/api/systems/:id/check`                         | Check one system for updates.                                       |
| POST   | `/api/systems/:id/cancel`                        | Request cancellation of the running operation on a system.          |
| POST   | `/api/systems/:id/package-issues/:issueId/solve` | Run the repair action for a package-manager issue.                  |
| POST   | `/api/systems/check-all`                         | Check all systems in the background.                                |
| POST   | `/api/systems/upgrade-all`                       | Queue an Upgrade All batch for selected systems.                    |
| POST   | `/api/systems/:id/upgrade`                       | Upgrade all visible packages on a system.                           |
| POST   | `/api/systems/:id/full-upgrade`                  | Full/dist upgrade on a supported system.                            |
| POST   | `/api/systems/:id/autoremove`                    | Remove unused packages or runtimes on a supported system.           |
| POST   | `/api/systems/:id/upgrade-packages`              | Upgrade one or more selected visible packages on a system.          |
| POST   | `/api/systems/:id/upgrade/:packageName`          | Compatibility alias for upgrading one selected package.             |
| POST   | `/api/cache/refresh`                             | Invalidate cache and re-check all systems.                          |

## Notifications

| Method | Endpoint                                                | Description                                                                   |
| ------ | ------------------------------------------------------- | ----------------------------------------------------------------------------- |
| GET    | `/api/notifications`                                    | List all notification channels.                                               |
| PUT    | `/api/notifications/reorder`                            | Reorder notification channels.                                                |
| GET    | `/api/notifications/:id`                                | Get a notification channel.                                                   |
| POST   | `/api/notifications`                                    | Create a notification channel.                                                |
| PUT    | `/api/notifications/:id`                                | Update a notification channel.                                                |
| DELETE | `/api/notifications/:id`                                | Delete a notification channel.                                                |
| POST   | `/api/notifications/:id/telegram/link`                  | Create a one-time Telegram chat binding link.                                 |
| POST   | `/api/notifications/:id/telegram/unlink`                | Remove Telegram chat binding and revoke any generated command token.          |
| POST   | `/api/notifications/:id/telegram/reissue-command-token` | Rotate the Telegram command token for a linked channel with commands enabled. |
| POST   | `/api/notifications/:id/reset-update-dedupe`            | Reset update notification deduplication for a channel.                        |
| POST   | `/api/notifications/test`                               | Test a notification config inline before saving.                              |
| POST   | `/api/notifications/:id/test`                           | Send a test notification for a saved channel.                                 |

Email channels accept an optional `config.emailSubjectPrefix` string, for example
`"[LINUX-UPDATE]"`. It is prepended to every email subject with a separating space,
including test emails and scheduled digests. Surrounding whitespace is trimmed;
an omitted, empty, or whitespace-only prefix leaves the subject unchanged.

Email channels also accept an optional `config.emailFormat`: `"html"` (default) sends
an HTML body with a plain-text alternative, and `"text"` sends plain text only, with
the dashboard or release link appended to the message.

## Schedules

| Method | Endpoint                 | Description        |
| ------ | ------------------------ | ------------------ |
| GET    | `/api/schedules`         | List schedules.    |
| PUT    | `/api/schedules/reorder` | Reorder schedules. |
| GET    | `/api/schedules/:id`     | Get a schedule.    |
| POST   | `/api/schedules`         | Create a schedule. |
| PUT    | `/api/schedules/:id`     | Update a schedule. |
| DELETE | `/api/schedules/:id`     | Delete a schedule. |

Schedule `type` can be `refresh`, `update`, `autoremove`, `reboot`, or
`notification_digest`. All schedule types use `config.cron`. System-targeted
schedules accept `systemIds: null` for all systems or an array of system IDs.
`reboot` schedules accept an optional `config.onlyIfRequired` boolean; when
`true`, scoped systems are refreshed first and only those that still report a
pending reboot are rebooted.

## Scripts

| Method | Endpoint                                     | Description                                                                                     |
| ------ | -------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| GET    | `/api/scripts`                               | List built-in and custom scripts, package-manager definitions, and placeholder help.            |
| POST   | `/api/scripts`                               | Create a custom script.                                                                         |
| PUT    | `/api/scripts/:id`                           | Update a custom script.                                                                         |
| DELETE | `/api/scripts/:id`                           | Delete an unused custom script.                                                                 |
| POST   | `/api/scripts/package-managers`              | Create a custom package-manager definition.                                                     |
| GET    | `/api/scripts/package-managers/:name/export` | Export a custom package-manager bundle.                                                         |
| POST   | `/api/scripts/package-managers/import`       | Import a custom package-manager bundle.                                                         |
| PUT    | `/api/scripts/package-managers/:name`        | Update package-manager metadata, parser settings, and custom config entries.                    |
| DELETE | `/api/scripts/package-managers/:name`        | Delete an unused custom package-manager definition. Optional body: `{ "deleteScripts": true }`. |
| POST   | `/api/scripts/validate-parser`               | Test custom parser settings against sample command output.                                      |
| POST   | `/api/scripts/format`                        | Format a shell command for display/editing.                                                     |

## Credentials

| Method | Endpoint                   | Description                            |
| ------ | -------------------------- | -------------------------------------- |
| GET    | `/api/credentials`         | List saved SSH and secret credentials. |
| PUT    | `/api/credentials/reorder` | Reorder credentials.                   |
| GET    | `/api/credentials/:id`     | Get a credential with masked secrets.  |
| POST   | `/api/credentials`         | Create a credential.                   |
| PUT    | `/api/credentials/:id`     | Update a credential.                   |
| DELETE | `/api/credentials/:id`     | Delete a credential.                   |

Credential kinds are `usernamePassword`, `sshKey`, `certificate`, and `secret`.
A `secret` credential has a single `value` field. It must be one line of at
most 4096 characters, and responses mask it as `(stored)`. A credential that a
system references, either for SSH or for a secret config entry, cannot be
deleted. Its references list the system, plus `pkgManager` and `key` for secret
entries.

## Passkeys

| Method | Endpoint            | Description                               |
| ------ | ------------------- | ----------------------------------------- |
| GET    | `/api/passkeys`     | List passkeys for the authenticated user. |
| PATCH  | `/api/passkeys/:id` | Rename a passkey.                         |
| DELETE | `/api/passkeys/:id` | Remove a passkey.                         |

## API Token Management

These routes manage API tokens and cannot be called with API tokens.

| Method | Endpoint          | Description                                                  |
| ------ | ----------------- | ------------------------------------------------------------ |
| GET    | `/api/tokens`     | List tokens for the authenticated user.                      |
| POST   | `/api/tokens`     | Create a token with `name`, `expiresInDays`, and `readOnly`. |
| PATCH  | `/api/tokens/:id` | Rename a token.                                              |
| DELETE | `/api/tokens/:id` | Revoke a token.                                              |

## WebSocket

| Endpoint                     | Description                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| `/api/ws/systems/:id/output` | Live command output stream for one system. Auth is checked during the HTTP upgrade request. |
