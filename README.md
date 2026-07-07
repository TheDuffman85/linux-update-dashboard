<div align="center">
  <img src="assets/logo.svg" alt="Linux Update Dashboard Logo" width="250" />
</div>

<div align="center">

[![Build](https://img.shields.io/github/actions/workflow/status/TheDuffman85/linux-update-dashboard/release.yml?style=flat-square&logo=github&label=build)](https://github.com/TheDuffman85/linux-update-dashboard/actions/workflows/release.yml)
[![Trivy Scan](https://img.shields.io/github/actions/workflow/status/TheDuffman85/linux-update-dashboard/trivy-scan.yml?style=flat-square&logo=aqua&label=security)](https://github.com/TheDuffman85/linux-update-dashboard/actions/workflows/trivy-scan.yml)
[![GitHub License](https://img.shields.io/github/license/TheDuffman85/linux-update-dashboard?style=flat-square&logo=github)](https://github.com/TheDuffman85/linux-update-dashboard/blob/main/LICENSE)
[![GitHub last commit](https://img.shields.io/github/last-commit/TheDuffman85/linux-update-dashboard?style=flat-square&logo=github)](https://github.com/TheDuffman85/linux-update-dashboard/commits/main)
[![Latest Container](https://img.shields.io/badge/ghcr.io-latest-blue?style=flat-square&logo=github)](https://github.com/users/TheDuffman85/packages/container/package/linux-update-dashboard)

</div>

# Linux Update Dashboard

A self-hosted web app for managing Linux package updates across multiple servers. Connect over SSH, check for updates, and apply maintenance from one browser dashboard.

<div align="center">
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node.js-%235FA04E.svg?style=for-the-badge&logo=node.js&logoColor=white" alt="Node.js" /></a>
  <a href="https://pnpm.io/"><img src="https://img.shields.io/badge/pnpm-%23F69220.svg?style=for-the-badge&logo=pnpm&logoColor=white" alt="pnpm" /></a>
  <a href="https://hono.dev/"><img src="https://img.shields.io/badge/hono-%23E36002.svg?style=for-the-badge&logo=hono&logoColor=white" alt="Hono" /></a>
  <a href="https://react.dev/"><img src="https://img.shields.io/badge/react-%2320232a.svg?style=for-the-badge&logo=react&logoColor=%2361DAFB" alt="React" /></a>
  <a href="https://vite.dev/"><img src="https://img.shields.io/badge/vite-%23646CFF.svg?style=for-the-badge&logo=vite&logoColor=white" alt="Vite" /></a>
  <a href="https://tailwindcss.com/"><img src="https://img.shields.io/badge/tailwindcss-%2338B2AC.svg?style=for-the-badge&logo=tailwind-css&logoColor=white" alt="Tailwind CSS" /></a>
  <a href="https://orm.drizzle.team/"><img src="https://img.shields.io/badge/drizzle-%23C5F74F.svg?style=for-the-badge&logo=drizzle&logoColor=black" alt="Drizzle ORM" /></a>
  <a href="https://www.sqlite.org/"><img src="https://img.shields.io/badge/sqlite-%23003B57.svg?style=for-the-badge&logo=sqlite&logoColor=white" alt="SQLite" /></a>
  <a href="https://www.docker.com/"><img src="https://img.shields.io/badge/docker-%230db7ed.svg?style=for-the-badge&logo=docker&logoColor=white" alt="Docker" /></a>
</div>

## Features

- **Multi-distribution updates:** APT, DNF, YUM, Pacman, APK, Flatpak, Snap, and custom package managers.
- **SSH credential vault:** reusable password, key, and OpenSSH certificate credentials encrypted at rest with AES-256-GCM.
- **Automatic discovery:** package managers, OS metadata, installed package inventory, system info, reboot state, and distribution lifecycle status.
- **Granular maintenance:** refresh, upgrade all, grouped Upgrade All batches, selected-package upgrades, full upgrades, autoremove, cancellation, and remote reboot.
- **Per-system controls:** hidden systems, system duplication, default Upgrade All exclusion, package-manager toggles/config, APT kept-back auto-hide, script overrides, ProxyJump, and host-key trust approval.
- **Script customization:** inspect built-in SSH command scripts, copy them into editable custom scripts, define parser settings, import/export custom package managers, and assign overrides per system.
- **Scheduling:** cron-based refresh, update, and notification schedules with scoped systems, cache rules, ordered upgrade groups, and schedule run history.
- **Notifications:** Email/SMTP, Gotify, MQTT, ntfy.sh, Telegram, and Webhook channels with event filters, system scope, immediate or scheduled delivery, test sends, and encrypted secrets.
- **Home Assistant MQTT:** app and per-system update entities with discovery, retained state/attributes, rich metadata, images, and optional install commands.
- **Authentication:** password login with optional TOTP, passkeys/WebAuthn, OpenID Connect SSO, and API tokens for external integrations.
- **Localized UI:** Arabic, English, German, French, Hindi, Japanese, Portuguese, Spanish, Russian, and Chinese with browser-language detection.
- **Operator-friendly UI:** dark/light mode, activity history, real-time command output, dashboard status summaries, version/build info, and Docker-ready production packaging.

## Screenshots

<p>
  <a href="screenshots/1.png"><img src="screenshots/1.png" alt="Dashboard" width="48%"></a>
  <a href="screenshots/12.png"><img src="screenshots/12.png" alt="Upgrade All Systems" width="48%"></a>
</p>
<p>
  <a href="screenshots/3.png"><img src="screenshots/3.png" alt="Systems List" width="48%"></a>
  <a href="screenshots/4.png"><img src="screenshots/4.png" alt="Edit System" width="48%"></a>
</p>
<p>
  <a href="screenshots/2.png"><img src="screenshots/2.png" alt="System Detail" width="48%"></a>
  <a href="screenshots/13.png"><img src="screenshots/13.png" alt="Sudoers Setup" width="48%"></a>
</p>
<p>
  <a href="screenshots/5.png"><img src="screenshots/5.png" alt="Credentials" width="48%"></a>
  <a href="screenshots/6.png"><img src="screenshots/6.png" alt="Add Credential" width="48%"></a>
</p>
<p>
  <a href="screenshots/10.png"><img src="screenshots/10.png" alt="Schedules" width="48%"></a>
  <a href="screenshots/7.png"><img src="screenshots/7.png" alt="Notifications" width="48%"></a>
</p>
<p>
  <a href="screenshots/8.png"><img src="screenshots/8.png" alt="Add Notification" width="48%"></a>
  <a href="screenshots/11.png"><img src="screenshots/11.png" alt="Scripts" width="48%"></a>
</p>
<p>
  <a href="screenshots/9.png"><img src="screenshots/9.png" alt="Settings" width="48%"></a>
</p>

> [!CAUTION]
> **Use on trusted networks only.** Do not expose Linux Update Dashboard directly to the internet. For remote access, put it behind TLS, a hardened reverse proxy, authentication, and network-level controls such as VPN or firewall rules.

> [!IMPORTANT]
> **HTTPS is recommended.** Plain HTTP works for basic local dashboard use, but browsers restrict secure-context features such as passkeys/WebAuthn and clipboard actions. Behind a reverse proxy, set `LUDASH_BASE_URL` to the public `https://...` URL and enable `LUDASH_TRUST_PROXY=true`.

## Related Projects

<table>
  <tr>
    <td width="80" align="center" valign="middle">
      <a href="https://github.com/TheDuffman85/crowdsec-web-ui">
        <img src="https://raw.githubusercontent.com/TheDuffman85/crowdsec-web-ui/main/client/public/logo.svg" alt="CrowdSec Web UI Logo" width="56" />
      </a>
    </td>
    <td valign="middle">
      <a href="https://github.com/TheDuffman85/crowdsec-web-ui"><strong>CrowdSec Web UI</strong></a><br />
      A self-hosted web dashboard for CrowdSec to review alerts, manage decisions, configure notifications, and optionally view runtime metrics.
    </td>
  </tr>
</table>

## Quick Start

Prerequisites:

- Node.js 24.18.0
- pnpm 11.9.0 through Corepack or global install
- SSH access to at least one Linux server

```bash
git clone https://github.com/TheDuffman85/linux-update-dashboard.git
cd linux-update-dashboard

corepack enable
corepack prepare pnpm@11.9.0 --activate
pnpm install

export LUDASH_ENCRYPTION_KEY=$(openssl rand -base64 32)
pnpm run dev
```

The Vite frontend runs on `http://localhost:5173` and proxies API calls to the backend on port `3001`. The first visit guides you through creating the admin account.

Production from source:

```bash
pnpm run build
NODE_ENV=production pnpm run start
```

The production server serves the API and built frontend on port `3001`.

## Docker

Generate an encryption key once and persist it. Changing `LUDASH_ENCRYPTION_KEY` later makes existing encrypted credentials unreadable.

```bash
export LUDASH_ENCRYPTION_KEY=$(openssl rand -base64 32)
export LUDASH_BASE_URL=http://localhost:3001

docker run -d \
  --name linux-update-dashboard \
  -p 3001:3001 \
  -e LUDASH_ENCRYPTION_KEY=$LUDASH_ENCRYPTION_KEY \
  -e LUDASH_BASE_URL=$LUDASH_BASE_URL \
  -v ludash_data:/data \
  ghcr.io/theduffman85/linux-update-dashboard:latest
```

Set `LUDASH_BASE_URL` to the URL users and integrations actually use. Behind a reverse proxy, set the public HTTPS URL and add `LUDASH_TRUST_PROXY=true`.

### Docker Compose

```yaml
services:
  dashboard:
    image: ghcr.io/theduffman85/linux-update-dashboard:latest
    container_name: linux-update-dashboard
    restart: unless-stopped
    ports:
      - "3001:3001"
    volumes:
      - dashboard_data:/data
    environment:
      - LUDASH_ENCRYPTION_KEY=${LUDASH_ENCRYPTION_KEY}
      - LUDASH_DB_PATH=/data/dashboard.db
      - LUDASH_BASE_URL=http://localhost:3001
      - TZ=Europe/Berlin
      - NODE_ENV=production
      # Reverse proxy:
      # - LUDASH_BASE_URL=https://dashboard.example.com
      # - LUDASH_TRUST_PROXY=true

volumes:
  dashboard_data:
```

Docker Secrets are supported by setting `LUDASH_ENCRYPTION_KEY_FILE` instead of `LUDASH_ENCRYPTION_KEY`:

```yaml
services:
  dashboard:
    image: ghcr.io/theduffman85/linux-update-dashboard:latest
    container_name: linux-update-dashboard
    restart: unless-stopped
    ports:
      - "3001:3001"
    volumes:
      - dashboard_data:/data
    environment:
      - LUDASH_ENCRYPTION_KEY_FILE=/run/secrets/ludash_encryption_key
      - LUDASH_DB_PATH=/data/dashboard.db
      - LUDASH_BASE_URL=http://localhost:3001
      - NODE_ENV=production
    secrets:
      - ludash_encryption_key

secrets:
  ludash_encryption_key:
    file: ./secrets/ludash_encryption_key.txt

volumes:
  dashboard_data:
```

Create the secret before starting:

```bash
mkdir -p ./secrets
openssl rand -base64 32 > ./secrets/ludash_encryption_key.txt
docker compose up -d
```

For plain `docker run`, mount the secret file read-only and set `LUDASH_ENCRYPTION_KEY_FILE=/run/secrets/ludash_encryption_key`.

The repository also includes [`docker/docker-compose.yml`](docker/docker-compose.yml) for local image builds:

```bash
cd docker
export LUDASH_ENCRYPTION_KEY=$(openssl rand -base64 32)
export LUDASH_BASE_URL=http://localhost:3001
export TZ=Europe/Berlin
docker compose up -d
```

The image includes a health check for `GET /api/health`; loopback requests do not require auth, external requests do. The app returns `{"status":"ok"}` when healthy.

## Environment Variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `LUDASH_ENCRYPTION_KEY` | Yes | - | Secret used for stored credential and notification-secret encryption. Raw 32-byte base64 keys are used directly; other values are derived with PBKDF2-SHA256. |
| `LUDASH_ENCRYPTION_KEY_FILE` | No | - | Docker Secrets/file alternative for `LUDASH_ENCRYPTION_KEY`. Do not set both. |
| `LUDASH_DB_PATH` | No | `./data/dashboard.db` | SQLite database path. Docker images default this to `/data/dashboard.db`. |
| `LUDASH_SECRET_KEY` | No | auto-generated | JWT session signing secret, persisted to `.secret_key` next to the database when omitted. |
| `LUDASH_SECRET_KEY_FILE` | No | auto-generated | File alternative for `LUDASH_SECRET_KEY`. Do not set both. |
| `LUDASH_PORT` | No | `3001` | HTTP server port. |
| `LUDASH_HOST` | No | `0.0.0.0` | HTTP bind address. |
| `LUDASH_BASE_URL` | Recommended | `http://localhost:3001` | Public URL used for WebAuthn/OIDC and integration URLs such as Home Assistant `entity_picture`/`origin.url`. |
| `LUDASH_TRUST_PROXY` | No | `false` | Trust `X-Forwarded-*` headers behind a reverse proxy. |
| `TZ` | No | `UTC` | IANA timezone for the container/process, UI time display, and cron schedules. |
| `LUDASH_LOG_LEVEL` | No | `info` | `debug`, `info`, `warn`, or `error`. Debug adds SSH diagnostics and scheduler refresh logs. |
| `LUDASH_DEFAULT_CACHE_HOURS` | No | `12` | Startup default for cache reuse hours. User settings can override runtime behavior. |
| `LUDASH_DEFAULT_SSH_TIMEOUT` | No | `30` | Startup default SSH connect timeout in seconds. |
| `LUDASH_DEFAULT_CMD_TIMEOUT` | No | `120` | Startup default SSH command timeout in seconds. |
| `LUDASH_MAX_SSH_TIMEOUT` | No | `120` | Maximum SSH timeout accepted by settings/API. |
| `LUDASH_MAX_CMD_TIMEOUT` | No | `600` | Maximum command timeout accepted by settings/API. |
| `LUDASH_MAX_CONCURRENT_CONNECTIONS` | No | `5` | Startup default for simultaneous SSH connections. User settings can override runtime behavior. |
| `LUDASH_MIN_SCHEDULE_INTERVAL_MINUTES` | No | `5` | Minimum interval accepted for cron schedules. |
| `VITE_MIN_SCHEDULE_INTERVAL_MINUTES` | No | `5` | Build-time client hint for schedule interval warnings; set it to match `LUDASH_MIN_SCHEDULE_INTERVAL_MINUTES` when customizing. |
| `LUDASH_EOL_CATALOG_FILE` | No | - | Custom distribution lifecycle catalog used by `pnpm run generate:eol` and `pnpm run build`. |
| `NODE_EXTRA_CA_CERTS` | No | - | Additional PEM CA bundle for outbound TLS targets such as OIDC, SMTP, Gotify, ntfy, or webhooks. |
| `NODE_ENV` | No | - | Set to `production` to serve the built SPA from the backend. |

For secret-backed settings, do not set both `VAR` and `VAR_FILE`; startup fails with a configuration error when both are present for the same setting.

## Authentication and API

Linux Update Dashboard supports password login, TOTP authenticator codes, passkeys, OpenID Connect SSO, and API tokens. Passwords use bcrypt, TOTP secrets are encrypted at rest, sessions are HTTP-only JWT cookies with rolling refresh, and password login cannot be disabled unless passkeys or SSO are configured to prevent lockout.

TOTP can be enabled from **Settings > Password** after signing in with the account password. Once enabled, password sign-ins require a current authenticator app code.

For OIDC, configure the provider callback URL as `{LUDASH_BASE_URL}/api/auth/oidc/callback`. Set `LUDASH_BASE_URL` before configuring OIDC so callback and origin validation match the public URL.

API tokens are for external integrations such as [gethomepage](https://gethomepage.dev/) widgets, scripts, monitoring, and Telegram command automation. Tokens can be read-only or read/write, expire after 30/60/90/365 days or never, are stored as SHA-256 hashes, are limited to 25 per user, and cannot access management endpoints or configure SSH connections.

```bash
curl -H "Authorization: Bearer ludash_..." http://localhost:3001/api/dashboard/stats
```

The endpoint catalog lives in [API.md](API.md).

## Supported Package Managers

| Package Manager | Distributions |
| --- | --- |
| APT | Debian, Ubuntu, Linux Mint |
| DNF | Fedora, RHEL 8+, AlmaLinux, Rocky |
| YUM | CentOS, older RHEL |
| Pacman | Arch Linux, Manjaro |
| APK | Alpine Linux |
| Flatpak | Any cross-distribution host |
| Snap | Any cross-distribution host |
| Custom | User-defined scripts and parser rules |

Managers are detected over SSH when testing a connection or running the first check. Detected managers are enabled by default and can be toggled per system. Security updates are identified where the package manager exposes enough information.

Per-system manager settings include APT `upgrade` vs `full-upgrade` and kept-back auto-hide, DNF `upgrade` vs `distro-sync`, optional metadata refresh skips for DNF/Pacman/APK/Flatpak, and opt-in DNF/YUM automation for GPG-key and EULA prompts. Snap does not currently expose manager-specific settings.

## Scheduling and Upgrade Groups

Schedules are managed from the **Schedules** page. Existing installs migrate to an enabled **Default refresh** schedule using the previous refresh interval and cache settings.

- **Refresh schedules** re-check scoped systems when cached results are stale.
- **Update schedules** refresh scoped systems first, then run the normal per-system Upgrade action where visible updates remain.
- **Notification schedules** deliver pending event batches for assigned notification channels.

Schedules use five-field cron expressions in the process timezone. Set Docker `TZ`, such as `TZ=Europe/Berlin`, for local-time scheduling. The default minimum interval is 5 minutes and can be changed with `LUDASH_MIN_SCHEDULE_INTERVAL_MINUTES`.

The **Upgrade All Systems** dialog can save an ordered flow with optional groups. Systems in the same group run together; the next group starts only after the current group finishes. Hidden systems and systems excluded from Upgrade All are not queued unless explicitly included.

Set a refresh schedule's cache duration to `0` to disable cache reuse. Manual refreshes, server restarts, and newly added systems can still trigger checks outside configured schedules. Notification channels can be assigned to multiple notification schedules.

## Notifications

Notification channels are configured from the **Notifications** page. Each channel can choose event types (`updates`, `unreachable`, and `appUpdates`), system scope, immediate or scheduled delivery, and provider-specific settings. New channels default to `updates` and `appUpdates`. Secrets such as SMTP passwords, app tokens, bot tokens, command tokens, webhook credentials, and sensitive headers are encrypted at rest.

| Type | Best for | Notes |
| --- | --- | --- |
| `Email` | inbox alerts | SMTP with optional auth, Plain SMTP, STARTTLS, or implicit TLS. Prefer `NODE_EXTRA_CA_CERTS` for private CAs. |
| `Gotify` | self-hosted/mobile push | App token stored encrypted. |
| `MQTT` | brokers, automations, Home Assistant | Generic event publishing plus optional Home Assistant MQTT Update entities. |
| `ntfy` | lightweight push topics | Topic delivery with optional bearer token. |
| `Telegram` | chat alerts and optional commands | Private-chat binding only. Commands are off by default and require confirmations for mutating actions. |
| `Webhook` | custom integrations, chat ops, n8n, Node-RED, Discord | POST/PUT/PATCH, templates, query params, headers, auth, retries, timeout, and Discord preset. |

### MQTT and Home Assistant

`LUDASH_BASE_URL` should be explicitly set for Home Assistant. The MQTT integration can publish one app update entity and one per-system package update entity. Discovery config uses retained payloads; update state and JSON attributes are published on separate retained topics; install commands map to the normal per-system upgrade action when enabled. Notification schedules only affect the generic MQTT event topic, not Home Assistant state.

Per-system attributes include update counts, security counts, reboot state, reachability, active operation, detected host metadata, and pending package details. Package entity versions are synthetic fingerprints for the pending update set, not real package-version pairs.

### Telegram

Telegram notification setup:

1. Create a bot with [@BotFather](https://t.me/BotFather).
2. Create a `Telegram` channel in the dashboard and paste the bot token.
3. Save, reopen the channel, click **Create Link**, and open the generated private-chat link.
4. Start the bot in Telegram and use **Send Test** to verify delivery.

Bindings use single-use deep links that expire after 10 minutes and show `unbound`, `pending`, or `bound` status. Changing the bot token clears the binding.

Optional commands are private-chat-only, disabled by default, scoped to the channel's systems, and backed by an auto-generated write-capable API token. The token is revoked when commands are disabled, the chat is unlinked, the channel is deleted, or the bot token changes. Supported commands are `/help`, `/version`, `/menu`, `/status`, `/refresh <system-id|all>`, `/packages <system-id>`, `/upgrade <system-id|all>`, `/fullupgrade <system-id|all>`, and `/upgradepkg <system-id> <package>`. Mutating commands require confirmation buttons that expire after 5 minutes.

### Webhooks

Webhook channels support `POST`, `PUT`, and `PATCH`; custom or Discord presets; no auth, bearer auth, or basic auth; text, JSON template, or form bodies; query params; custom headers; timeout; retries; retry delay; and optional insecure TLS for trusted internal targets.

Templates use simple Mustache variable tags. Only dotted `event.*` paths are allowed; sections, loops, and other Mustache control tags are rejected. Common variables include `{{event.title}}`, `{{event.body}}`, `{{event.priority}}`, `{{event.sentAt}}`, totals under `{{event.totals.*}}`, text summaries, JSON payload helpers, and JSON-safe variants such as `{{event.titleJson}}` and `{{event.decoratedTitleJson}}`.

Webhook delivery defaults to a 10-second timeout, 2 retries, and a 30-second retry delay. URLs must be `http` or `https`, embedded URL credentials are rejected, cloud metadata endpoints are blocked, and reserved headers such as `Authorization`, `Host`, `Content-Length`, `Connection`, and `Cookie` cannot be set manually.

## Script Customization and Sudoers

The **Scripts** page exposes the SSH command templates for package-manager detection, update checks, installed-package inventory, issue repair, autoremove, upgrades, selected-package upgrades, system info, and reboots.

- Built-in scripts for APT, DNF, YUM, Pacman, APK, Flatpak, Snap, system-info, and reboot are read-only and can be copied.
- Custom scripts can define shell steps, operation type, parser settings, installed-package inventory parsing, and system-info section mapping.
- Per-system overrides can replace individual operations such as `apt/check_updates`, `apt/repair_issue`, `apt/autoremove`, `apt/upgrade_all`, or `system/reboot`.
- Custom package managers can define display labels, parser regexes, optional config entries, and import/export bundles.
- Used scripts and package managers are protected from accidental deletion.

Command placeholders include `{{package}}`, `{{packages}}`, `{{quotedPackage}}`, `{{quotedPackages}}`, `{{manager}}`, `{{config.someKey}}`, and `{{sudo:COMMAND}}`. Custom parser regexes should use named capture groups such as `packageName`, `newVersion`, `currentVersion`, `architecture`, and `repository`.

For restricted automation accounts, use a dedicated SSH user and leave the dashboard sudo password unset. The Systems page has a **Sudoers setup** action that generates a least-privilege `/etc/sudoers.d` allowlist for the selected system. Review generated files before installing them, keep commands exact, prefer absolute executable paths, leave selected-package wildcard rules commented unless needed, and avoid broad rules such as `NOPASSWD: ALL` or `sudo sh <writable-script>`.

Example validation after installing a generated file:

```bash
sudo chmod 440 /etc/sudoers.d/updater-updater
sudo visudo -cf /etc/sudoers.d/updater-updater
```

Package maintenance remains privileged because package scripts run as root. The goal is to limit the dashboard account to the required maintenance commands.

## SSH-Safe Maintenance

Upgrade operations and autoremove run through detached remote scripts with `nohup`, so they continue if SSH disconnects or the dashboard restarts. The dashboard streams output with `tail --pid`, captures the exit code from a companion file, and marks setup failures as failed instead of falling back to unsafe direct execution. If monitoring disconnects mid-operation, the remote process may still be running and the UI reports that warning.

| Operation | SSH-safe |
| --- | --- |
| Upgrade all packages | Yes |
| Full/dist upgrade | Yes |
| Upgrade selected packages | Yes |
| Autoremove unused packages/runtimes | Yes |
| Check for updates | No, read-only and retryable |
| Reboot | No, fire-and-forget |

If a sudo password is configured, it is sent only over the live SSH stdin stream to the privileged command. It is never written to files or environment variables. SSH-safe operations are marked with an **SSH-safe** badge in activity history.

## Distribution Lifecycle Warnings

The dashboard records `/etc/os-release` fields during refreshes and compares them with a bundled lifecycle catalog. Warnings appear on the dashboard, systems list, and system detail page when a release is near EOL, fully EOL, or in reduced support such as Debian LTS after regular Debian Security Support.

The warning window is configurable from **Settings > Lifecycle Warnings** and defaults to 180 days. Supported catalog keys are `ubuntu`, `debian`, `fedora`, `rhel`, `rocky`, `almalinux`, `centos`, `centos-stream`, `alpine`, and `proxmox`.

Lifecycle data is generated at build time by `scripts/generate-distro-lifecycle-data.mjs` from `https://endoflife.date/api`. The generated data lives in `server/generated/distro-lifecycle-data.json`, with `server/default-distro-lifecycle-catalog.json` as an offline fallback. `pnpm run build` runs the generator before compiling and keeps or falls back to local data if the remote API is unavailable.

Use a custom source catalog for repeatable builds:

```bash
LUDASH_EOL_CATALOG_FILE=/path/to/my-eol-catalog.json pnpm run generate:eol
# or
LUDASH_EOL_CATALOG_FILE=/path/to/my-eol-catalog.json pnpm run build
```

Custom catalogs use the same shape as `server/default-distro-lifecycle-catalog.json`; each entry needs `cycle` and `eol`, with optional `supportEnd`, `supportLabel`, and `finalSupportLabel`.

If you edit `server/generated/distro-lifecycle-data.json` directly, remember that `pnpm run build` regenerates it. Use `LUDASH_EOL_CATALOG_FILE` for repeatable custom data.

## Debugging SSH Connection Failures

For container installs, set `LUDASH_LOG_LEVEL=debug` and inspect logs:

```bash
docker logs -f linux-update-dashboard
```

At `info`, logs include startup, configuration, warnings, and errors. `debug` adds attempt-scoped SSH diagnostics and routine scheduler refresh logs. Failed test-connection requests include a debug reference ID you can match against logs.

Logged SSH diagnostics are limited to safe metadata such as host, port, username, auth type, elapsed time, and filtered auth/debug events. Passwords, sudo passwords, private keys, passphrases, tokens, and raw SSH payloads are never logged. Avoid leaving debug logging enabled longer than needed.

## Security

- Credentials and notification secrets are encrypted at rest with AES-256-GCM and per-entry random IVs/auth tags.
- Encryption keys can be raw base64 or passphrases derived via PBKDF2-SHA256 with 480k iterations and a per-instance salt.
- Sessions use HTTP-only, SameSite=Lax JWT cookies signed with HS256.
- State-changing API requests require a per-session CSRF token header.
- API inputs use strict type, format, and range validation.
- Auth endpoints are rate-limited: setup 3/min, login and WebAuthn verify 5/min, and failed bearer token attempts 20/min per IP.
- API tokens are hash-only, can be read-only, skip CSRF as stateless bearer requests, and are blocked from management endpoints and SSH connection configuration.
- Password login uses timing-safe dummy-hash comparisons to reduce username enumeration risk.
- OIDC client secrets are encrypted at rest and can use private/self-signed CAs through `NODE_EXTRA_CA_CERTS`.
- Per-system mutexes and a semaphore-based SSH connection limit prevent conflicting or runaway SSH operations.

## Architecture

- **Client:** React, React Router, TanStack Query, Vite, Tailwind CSS in `client/`; production output goes to `dist/client`.
- **Server:** Node.js and Hono in `server/`; compiled output goes to `dist/server`.
- **Database:** SQLite with Drizzle schema/migrations; startup creates and upgrades schema automatically.
- **SSH:** `ssh2` connection manager, package-manager parsers, command scripts, output streaming, ProxyJump support, and host-key validation.
- **Runtime services:** scheduling, caching, notification delivery, MQTT/Home Assistant state, app update checks, and distribution lifecycle resolution.

## Project Structure

```text
├── .github/                  # CI/CD workflows and Dependabot
├── assets/                   # Logo assets served by the app
├── client/                   # React SPA, routes, hooks, components, styles, locales
├── docker/                   # Dockerfile, compose, entrypoint, test systems
├── examples/                 # Custom package-manager examples
├── screenshots/              # README screenshots and capture scripts
├── scripts/                  # Build-time helper scripts
├── server/                   # Hono backend, auth, db, routes, services, ssh
├── tests/server/             # Vitest server and integration tests
├── run.sh                    # Local dev/production/test runner
├── reset-dev-branch.sh       # Reset dev branch to main
├── vite.config.ts            # Vite + Tailwind config
└── package.json
```

## Development

Use the helper:

```bash
./run.sh dev    # hot reload, backend :3001, client :5173
./run.sh        # build and start production server on :3001
./run.sh test   # production server plus Docker test systems
```

Or use pnpm directly:

```bash
pnpm run dev
pnpm run dev:server
pnpm run dev:client
pnpm test
pnpm run check
```

### Test Systems

`./run.sh test` stops running services, builds and starts 17 Docker SSH fixtures, builds the frontend, and starts the production server on `:3001`. Add test systems in the dashboard with `host.docker.internal` or `172.17.0.1` on Linux and the matching SSH port.

Shared credentials:

- User `testuser`, password `testpass`
- `Sudo password`: `testpass` for `ludash-test-ubuntu-sudo` and `ludash-test-debian-fish-sudo`, optional for most others
- `ludash-test-ubuntu-root` also accepts `root` / `testpass` for root-login banner testing

| Container | SSH Port | Package Manager / Fixture | Base |
| --- | --- | --- | --- |
| `ludash-test-ubuntu` | 2001 | APT | Ubuntu 24.04 |
| `ludash-test-fedora` | 2002 | DNF | Fedora 41 |
| `ludash-test-centos7` | 2003 | YUM | CentOS 7 |
| `ludash-test-archlinux` | 2004 | Pacman | Arch Linux |
| `ludash-test-flatpak` | 2005 | Flatpak | Ubuntu 24.04 |
| `ludash-test-snap` | 2006 | Snap | Ubuntu 24.04 |
| `ludash-test-ubuntu-sudo` | 2007 | APT with sudo password | Ubuntu 24.04 |
| `ludash-test-debian-fish` | 2008 | APT with fish shell | Debian 12 |
| `ludash-test-debian-fish-sudo` | 2009 | APT, fish, sudo password | Debian 12 |
| `ludash-test-alpine` | 2010 | APK | Alpine 3.16 |
| `ludash-test-apt-keptback` | 2011 | APT kept-back fixture | Debian 12 |
| `ludash-test-apt-snap-partial` | 2012 | APT + failing Snap fixture | Ubuntu 24.04 |
| `ludash-test-dnf-gpg-prompt` | 2013 | DNF GPG key prompt fixture | Fedora 41 |
| `ludash-test-dnf-eula-prompt` | 2014 | DNF EULA prompt fixture | Fedora 41 |
| `ludash-test-apt-dpkg-interrupted` | 2015 | APT interrupted dpkg fixture | Debian 12 |
| `ludash-test-ubuntu-root` | 2016 | APT root-login/full sudo fixture | Ubuntu 24.04 |
| `ludash-test-custom-package-managers` | 2017 | npm/pip/pipx custom fixtures | Ubuntu 24.04 |

Fixtures pin older package versions from archived or local repositories while current repos stay active, so package-manager checks report deterministic pending updates. Special fixtures cover kept-back packages, partial multi-manager failures, DNF GPG prompts, DNF EULA prompts, interrupted dpkg repair, root-login behavior, and custom package manager examples in [`examples/`](examples/).

Most test users are restricted through least-privilege sudoers allowlists in [`docker/test-systems/sudoers/`](docker/test-systems/sudoers/). Selected-package operations use reviewed argument wildcards only where a fixture needs them.

Docker integration tests are opt-in, for example:

```bash
LUDASH_RUN_DOCKER_INTEGRATION=1 pnpm vitest run tests/server/apt-sudo-password.integration.test.ts
```

### Branch Management

Reset `dev` to `main` and force push:

```bash
./reset-dev-branch.sh
```

## Translations

Translations live in `client/locales/`. Browser-language detection applies to the UI. Server-generated text such as notifications and scheduled messages uses the saved language setting; with **Browser default**, background server text falls back to English because no browser locale is available.

Contributions for corrections, more natural wording, and new languages are welcome. Keep the same keys as `client/locales/en.json`.

## Star History

[![Star History Chart](https://api.star-history.com/chart?repos=TheDuffman85/linux-update-dashboard&type=date&legend=top-left&sealed_token=hsM5iehhuIgZct4apBouaoNlJfMtMPOHDMswSPq_Z2UCqQ_STymmzRdualR-pS_9cMQUtJRpVYTzOFTX_AsDXodHvJP8faYD2-zBf5_43jpZsaIp0xDOU3260-IZt216pEgQL4spbk6H2umAm8xELXshOr6dB5o2UUcf88eh0L2j034aPBl4AmDAB328)](https://www.star-history.com/?type=date&repos=TheDuffman85%2Flinux-update-dashboard)
