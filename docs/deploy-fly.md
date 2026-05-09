# Deploying Relai to Fly.io

This walks through getting the Relai API onto Fly.io with managed Postgres. It
covers the API only — the web dashboard is a static Vite build that's easiest
to host on Vercel/Netlify/Cloudflare Pages, or skip entirely for a CLI/MCP-only
deploy.

## Prerequisites

- A Fly.io account (`flyctl auth signup` or `flyctl auth login`)
- `flyctl` installed: `brew install flyctl` (macOS) or see [fly.io/docs/hands-on/install-flyctl](https://fly.io/docs/hands-on/install-flyctl/)
- This repo cloned locally

## 1. Pick an app name

The provided `fly.toml` uses `relai-api` as a placeholder. App names are global
on Fly.io, so edit `fly.toml` and set `app = "..."` to something unique (e.g.
`relai-api-yourname`).

## 2. Launch the app (no deploy yet)

From the repo root:

```bash
fly launch --no-deploy --copy-config
```

`--copy-config` keeps the existing `fly.toml`. Pick the same `primary_region`
the file specifies (default: `iad` — change in `fly.toml` first if you want a
closer region).

## 3. Provision managed Postgres

```bash
fly postgres create --name relai-db --region iad
fly postgres attach relai-db --app <your-app-name>
```

The `attach` command sets `DATABASE_URL` as a secret on the API app
automatically. **Note:** Fly's managed Postgres (single-node) has a free
allowance but is not redundant — fine for demos, not for production.

## 4. Set the remaining secrets

```bash
# Required: deprecated shared admin secret (still used by seed scripts).
# Generate a strong random value.
fly secrets set API_SECRET=$(openssl rand -hex 32) --app <your-app-name>

# Optional: enables Claude fallback routing for unrouteable tasks, AND the
# in-API message loop's classifier (handoff/question/finding) when
# ENABLE_MESSAGE_ROUTING is on.
fly secrets set ANTHROPIC_API_KEY=sk-ant-... --app <your-app-name>

# Optional: turn on the in-API message loop. Off by default — the classifier
# costs one Claude call per inbound handoff/question/finding message.
fly secrets set ENABLE_MESSAGE_ROUTING=true --app <your-app-name>
```

`DATABASE_URL` is already set by step 3. `API_PORT` and `TASK_POLL_MS` are
defaulted in `fly.toml [env]`.

## 5. Deploy

```bash
fly deploy
```

The `[deploy] release_command` in `fly.toml` runs `pnpm --filter @getrelai/db
db:push` before the new machines accept traffic, so additive schema changes
land automatically. **Renames** must be applied manually first via
`fly postgres connect -a relai-db` and a raw `ALTER TABLE … RENAME COLUMN …`
(drizzle-kit's push is interactive on renames; see AGENTS.md).

## 6. Verify

```bash
fly logs --app <your-app-name>          # watch the API boot
fly status --app <your-app-name>        # machine state, IPs, region
curl -i https://<your-app-name>.fly.dev/health \
     -H "Authorization: Bearer $API_SECRET"
# → 200 with the health payload
```

## 7. Bootstrap a project + agent

Either against the deployed API directly with the seed script:

```bash
API_SECRET=<your-secret> API_URL=https://<your-app-name>.fly.dev \
  tsx scripts/seed.ts demo-project demo-agent orchestrator
```

…or via the CLI from a fresh machine:

```bash
relai init     # prompts for API URL + secret, registers an agent
```

For inviting a coworker, see `docs/two-person-test.md`.

## Resource sizing

The provided `fly.toml` requests `shared-cpu-1x` / 512 MB. That's enough for
demos and a handful of agents. For more sustained load, bump to `shared-cpu-2x`
or `dedicated-cpu-1x` and raise `memory`.

`min_machines_running = 0` lets the API scale to zero when idle (≈cold start
of 1–3s on the next request). For an "always warm" demo set it to `1` instead
— the cost difference on `shared-cpu-1x` is small.

## Roadmap notes

- `/health` is auth-gated, so the Fly health probe is a TCP check today. Add an
  unauthed `/livez` route once we want richer probes.
- The web dashboard is not deployed by this config — host it on Vercel/Netlify
  or add a separate Fly app.
- Verification predicates (`verifyCommand`) execute inside the API process.
  Self-hosted only; not safe for hosted multi-tenant. See AGENTS.md / project
  state for the sandbox plan.
