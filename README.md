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

A self-hosted web application for centralized Linux package update management. Connect to remote servers over SSH, check for available updates, and apply them — all from a single browser-based dashboard.

<div align="center">
  <a href="https://bun.sh/"><img src="https://img.shields.io/badge/Bun-%23000000.svg?style=for-the-badge&logo=bun&logoColor=white" alt="Bun" /></a>
  <a href="https://hono.dev/"><img src="https://img.shields.io/badge/hono-%23E36002.svg?style=for-the-badge&logo=hono&logoColor=white" alt="Hono" /></a>
  <a href="https://react.dev/"><img src="https://img.shields.io/badge/react-%2320232a.svg?style=for-the-badge&logo=react&logoColor=%2361DAFB" alt="React" /></a>
  <a href="https://vite.dev/"><img src="https://img.shields.io/badge/vite-%23646CFF.svg?style=for-the-badge&logo=vite&logoColor=white" alt="Vite" /></a>
  <a href="https://tailwindcss.com/"><img src="https://img.shields.io/badge/tailwindcss-%2338B2AC.svg?style=for-the-badge&logo=tailwind-css&logoColor=white" alt="Tailwind CSS" /></a>
  <a href="https://orm.drizzle.team/"><img src="https://img.shields.io/badge/drizzle-%23C5F74F.svg?style=for-the-badge&logo=drizzle&logoColor=black" alt="Drizzle ORM" /></a>
  <a href="https://www.sqlite.org/"><img src="https://img.shields.io/badge/sqlite-%23003B57.svg?style=for-the-badge&logo=sqlite&logoColor=white" alt="SQLite" /></a>
  <a href="https://www.docker.com/"><img src="https://img.shields.io/badge/docker-%230db7ed.svg?style=for-the-badge&logo=docker&logoColor=white" alt="Docker" /></a>
</div>

## Features

- **Multi-Distribution Support** — APT (Debian/Ubuntu), DNF (Fedora/RHEL 8+), YUM (CentOS/older RHEL), Pacman (Arch/Manjaro), Flatpak, and Snap
- **Automatic Detection** — All supported package managers and system info are auto-detected on first connection; individual managers can be disabled per system
- **Granular Updates** — Upgrade all packages at once or select individual packages per system
- **Background Scheduling** — Automatic periodic checks keep your dashboard current (configurable cache duration)
- **Flexible Notifications** — Multiple notification channels per type (Email/SMTP, ntfy.sh), each scoped to specific systems or all, with per-channel event selection
- **Secure Credentials** — SSH passwords and private keys are encrypted at rest with AES-256-GCM
- **Three Auth Methods** — Password, Passkeys (WebAuthn), and SSO (OpenID Connect)
- **Dark Mode** — Full dark/light theme with OS preference detection
- **Update History** — Track every check and upgrade operation per system
- **Real-Time Status** — See which systems are online, up-to-date, or need attention at a glance
- **Docker Ready** — Multi-stage Dockerfile with persistent volume for production deployment

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) 1.x installed
- SSH access to at least one Linux server

### Installation

```bash
# Clone the repository
git clone https://github.com/your-username/linux-update-dashboard.git
cd linux-update-dashboard

# Install dependencies
bun install

# Generate an encryption key
export LUDASH_ENCRYPTION_KEY=$(bun -e "console.log(require('crypto').randomBytes(32).toString('base64'))")

# Start development servers
bun run dev
```

The frontend dev server runs on `http://localhost:5173` (proxies API calls to the backend on port 3001).

On first visit, you'll be guided through creating an admin account.

### Production Build

```bash
bun run build
NODE_ENV=production bun run start
```

The production server serves both the API and the built frontend on port 3001.

## Docker Deployment

### Using pre-built image (recommended)

```bash
# Generate your encryption key
export LUDASH_ENCRYPTION_KEY=$(openssl rand -base64 32)

# Pull and run
docker run -d \
  -p 3001:3001 \
  -e LUDASH_ENCRYPTION_KEY=$LUDASH_ENCRYPTION_KEY \
  -v ludash_data:/data \
  ghcr.io/theduffman85/linux-update-dashboard:latest
```

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
      - NODE_ENV=production

volumes:
  dashboard_data:
```

The dashboard will be available at `http://localhost:3001`. Data is persisted in a Docker volume.

### Building locally

```bash
cd docker

# Generate your encryption key
export LUDASH_ENCRYPTION_KEY=$(openssl rand -base64 32)

# Start the container
docker compose up -d
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LUDASH_ENCRYPTION_KEY` | **Yes** | — | AES-256 key for encrypting stored SSH credentials |
| `LUDASH_DB_PATH` | No | `./data/dashboard.db` | SQLite database file path |
| `LUDASH_SECRET_KEY` | No | Auto-generated | JWT session signing secret (auto-persisted to `.secret_key`) |
| `LUDASH_PORT` | No | `3001` | HTTP server port |
| `LUDASH_HOST` | No | `0.0.0.0` | HTTP server bind address |
| `LUDASH_BASE_URL` | No | `http://localhost:3001` | Public URL (required for WebAuthn and OIDC) |
| `LUDASH_LOG_LEVEL` | No | `info` | Log level |
| `LUDASH_DEFAULT_CACHE_HOURS` | No | `12` | How long update results are cached before re-checking |
| `LUDASH_DEFAULT_SSH_TIMEOUT` | No | `30` | SSH connection timeout in seconds |
| `LUDASH_DEFAULT_CMD_TIMEOUT` | No | `120` | SSH command execution timeout in seconds |
| `LUDASH_MAX_CONCURRENT_CONNECTIONS` | No | `5` | Maximum simultaneous SSH connections |
| `NODE_ENV` | No | — | Set to `production` for static file serving |

## Authentication

Three authentication methods are supported simultaneously:

### Password

Standard username and password login. Passwords are hashed with bcrypt (cost factor 12). Sessions are stored as JWT cookies with a 7-day expiry.

### Passkeys (WebAuthn)

Register hardware keys or platform authenticators (Touch ID, Windows Hello) for passwordless login. Requires `LUDASH_BASE_URL` to be set correctly.

### SSO (OpenID Connect)

Connect any OIDC-compatible identity provider (Authentik, Keycloak, Okta, Auth0, etc.) via the Settings page. Users are auto-provisioned on first login. The callback URL to configure in your provider is:

```
{LUDASH_BASE_URL}/api/auth/oidc/callback
```

## Supported Package Managers

| Package Manager | Distributions |
|----------------|---------------|
| APT | Debian, Ubuntu, Linux Mint |
| DNF | Fedora, RHEL 8+, AlmaLinux, Rocky |
| YUM | CentOS, older RHEL |
| Pacman | Arch Linux, Manjaro |
| Flatpak | Any (cross-distribution) |
| Snap | Any (cross-distribution) |

All supported package managers are automatically detected on each system via SSH during connection testing or first check. Detected managers are enabled by default and can be individually disabled per system in the edit dialog. Security updates are identified where supported (e.g., APT security repositories).

## Project Structure

```
├── .github/                  # CI/CD workflows and Dependabot
│   ├── dependabot.yml
│   └── workflows/
│       ├── dev-build.yml     # Dev branch Docker builds
│       ├── release.yml       # Production releases
│       └── trivy-scan.yml    # Container security scanning
├── client/                   # React SPA
│   ├── lib/                  # TanStack Query hooks and API client
│   ├── components/           # Shared UI components
│   ├── context/              # Auth and toast providers
│   ├── hooks/                # Custom hooks (theme)
│   ├── pages/                # Route pages
│   └── styles/               # Tailwind CSS
├── server/                   # Hono backend
│   ├── auth/                 # Password, WebAuthn, OIDC, session handling
│   ├── db/                   # SQLite + Drizzle schema (7 tables)
│   ├── middleware/            # Auth middleware
│   ├── routes/               # API route handlers
│   ├── services/             # Business logic, caching, scheduling
│   └── ssh/                  # SSH connection manager + parsers
├── tests/server/             # Bun test suites
├── docker/                   # Dockerfile, compose, entrypoint
├── run.sh                    # Local dev/production runner
├── reset-dev-branch.sh       # Reset dev branch to main
├── drizzle.config.ts         # Drizzle Kit configuration
├── vite.config.ts            # Vite + Tailwind config
└── package.json
```

## Development

The project includes a helper script `run.sh` to manage services.

**Development Mode** (Hot Reload — server on :3001, client on :5173):
```bash
./run.sh dev
```

**Production Mode** (Build and start on :3001):
```bash
./run.sh
```

Or use the npm scripts directly:

```bash
# Start both dev servers (backend :3001 + Vite :5173 with HMR)
bun run dev

# Or run them individually
bun run dev:server           # Backend only (with watch mode)
bun run dev:client           # Vite frontend only

# Run tests
bun test

# Type check
bun run check

# Database management
bun run db:generate          # Generate migrations from schema changes
bun run db:migrate           # Apply pending migrations
bun run db:studio            # Open Drizzle Studio GUI
```

### Branch Management

To reset the `dev` branch to match `main` (force push):
```bash
./reset-dev-branch.sh
```

## API Overview

All endpoints require authentication unless noted. Responses are JSON.

### Auth (`/api/auth/*`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/auth/status` | Auth state, setup status, OIDC availability |
| POST | `/api/auth/setup` | Create initial admin account |
| POST | `/api/auth/login` | Password login |
| POST | `/api/auth/logout` | Clear session |
| GET | `/api/auth/me` | Current user info |
| POST | `/api/auth/webauthn/register/options` | Start passkey registration |
| POST | `/api/auth/webauthn/register/verify` | Complete passkey registration |
| POST | `/api/auth/webauthn/login/options` | Start passkey login |
| POST | `/api/auth/webauthn/login/verify` | Complete passkey login |
| GET | `/api/auth/oidc/login` | Redirect to OIDC provider |
| GET | `/api/auth/oidc/callback` | OIDC callback handler |

### Systems (`/api/systems/*`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/systems` | List all systems with update counts |
| GET | `/api/systems/:id` | System detail with updates and history |
| POST | `/api/systems` | Add a new system |
| PUT | `/api/systems/:id` | Update system configuration |
| DELETE | `/api/systems/:id` | Remove a system |
| POST | `/api/systems/:id/test-connection` | Test SSH connectivity |

### Updates

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/systems/:id/check` | Check one system for updates |
| POST | `/api/systems/check-all` | Check all systems (background) |
| POST | `/api/systems/:id/upgrade` | Upgrade all packages on a system |
| POST | `/api/systems/:id/upgrade/:packageName` | Upgrade a single package |
| POST | `/api/cache/refresh` | Invalidate cache and re-check all systems |

### Notifications (`/api/notifications/*`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/notifications` | List all notification channels |
| GET | `/api/notifications/:id` | Get a notification channel |
| POST | `/api/notifications` | Create a notification channel |
| PUT | `/api/notifications/:id` | Update a notification channel |
| DELETE | `/api/notifications/:id` | Delete a notification channel |
| POST | `/api/notifications/:id/test` | Send a test notification |

### Dashboard & Settings

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/dashboard/stats` | Summary statistics |
| GET | `/api/dashboard/systems` | All systems with status metadata |
| GET | `/api/settings` | Current settings |
| PUT | `/api/settings` | Update settings |

## Security

- **Credential encryption** — SSH passwords and private keys are encrypted at rest using AES-256-GCM with per-entry random IVs and authentication tags
- **Notification secrets** — SMTP passwords and ntfy tokens are encrypted at rest within notification channel configs
- **Key derivation** — Supports both raw base64 keys and passphrase-derived keys (PBKDF2-SHA256, 480,000 iterations)
- **Session security** — HTTP-only, SameSite=Lax cookies with JWT (HS256)
- **Input validation** — Strict type, format, and range validation on all API inputs
- **SSRF protection** — Outbound notification URLs are validated against private/internal IP ranges
- **Concurrent access control** — Per-system mutex prevents conflicting SSH operations
- **Connection pooling** — Semaphore-based concurrency limiting to prevent SSH connection exhaustion

## License

MIT
