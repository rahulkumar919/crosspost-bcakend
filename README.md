# CrossPost AI — Backend

Express + TypeScript REST API. Handles auth, platform OAuth, media uploads, AI content generation, and BullMQ-backed cross-platform publishing.

## Stack

| Layer | Tech |
|---|---|
| Runtime | Node.js 20+ |
| Framework | Express 4 + TypeScript |
| Database | PostgreSQL via Prisma ORM |
| Queue | BullMQ + Upstash Redis |
| Storage | Cloudinary |
| AI | Ollama (self-hosted Llama) |
| Auth | JWT (bcrypt + jsonwebtoken) |

## Quick start

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

Copy `.env.example` to `.env` and fill in every value:

```bash
cp .env.example .env
```

Key values to set:

| Var | How to get it |
|---|---|
| `DATABASE_URL` | Local Postgres or [Neon](https://neon.tech) |
| `UPSTASH_REDIS_URL` | [Upstash Console](https://console.upstash.com) → Redis → Connect |
| `ENCRYPTION_KEY` | `openssl rand -hex 32` (must be 64 hex chars) |
| `JWT_SECRET` | `openssl rand -hex 64` |
| `CLOUDINARY_*` | [Cloudinary Console](https://cloudinary.com) |
| `OLLAMA_BASE_URL` | `http://localhost:11434` (local) or remote VM |
| `YOUTUBE_*` | [Google Cloud Console](https://console.cloud.google.com) |
| `INSTAGRAM_*` | [Meta for Developers](https://developers.facebook.com) |
| `LINKEDIN_*` | [LinkedIn Developer Portal](https://developer.linkedin.com) |

### 3. Set up the database

```bash
npm run prisma:migrate   # creates tables and runs migrations
npm run prisma:generate  # generates the Prisma client
```

### 4. Start Ollama (AI)

```bash
ollama serve             # starts the local inference server
ollama pull llama3.1:8b  # downloads the model (first run only)
```

### 5. Run in development

```bash
npm run dev              # ts-node-dev with hot reload on :4000
```

### 6. Build for production

```bash
npm run build   # compiles TypeScript → dist/
npm start       # runs dist/server.js
```

## API routes

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health` | — | Service health check |
| POST | `/auth/signup` | — | Register with email + password |
| POST | `/auth/login` | — | Login → returns JWT |
| GET | `/auth/me` | ✓ | Current user |
| GET | `/accounts` | ✓ | List connected platforms |
| GET | `/accounts/connect/:platform` | ✓ | Start OAuth flow |
| GET | `/accounts/callback/:platform` | — | OAuth callback (CSRF-protected via Redis state) |
| DELETE | `/accounts/:platform` | ✓ | Disconnect platform |
| POST | `/media/upload` | ✓ | Upload media to Cloudinary (multipart) |
| POST | `/ai/generate` | ✓ | Generate title/description/hashtags |
| POST | `/ai/enhance` | ✓ | Improve existing content |
| POST | `/posts` | ✓ | Create draft post with platform targets |
| GET | `/posts/:id` | ✓ | Get post + targets |
| POST | `/posts/:id/publish` | ✓ | Enqueue BullMQ publish jobs |
| GET | `/posts/:id/status` | ✓ | Poll publish status |
| POST | `/posts/:id/retry/:platform` | ✓ | Retry a failed platform |

All authenticated routes require `Authorization: Bearer <jwt>`.

## OAuth redirect URIs to register

Register these in each platform's developer console:

| Platform | Redirect URI |
|---|---|
| YouTube (Google) | `http://localhost:4000/accounts/callback/youtube` |
| Instagram (Meta) | `http://localhost:4000/accounts/callback/instagram` |
| LinkedIn | `http://localhost:4000/accounts/callback/linkedin` |

## Architecture notes

- **Token security** — OAuth access/refresh tokens are AES-256-GCM encrypted at rest (`lib/encryption.ts`). The encryption key must be exactly 32 bytes (64 hex chars).
- **Publish queue** — Each platform target gets its own BullMQ job with 3 retries and exponential backoff (5s → 25s → 125s). The worker runs in-process with the API server.
- **AI fallback** — If Ollama returns invalid JSON, the service retries once with a stricter prompt before returning an error.
- **Rate limits** — General: 100 req/min. Auth: 20 req/15min. AI: 10 req/min (per user when authenticated).
