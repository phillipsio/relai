# Deploying Relai to Render

This walks through deploying both the OSS API (`relai`) and the closed-cloud dashboard (`relai-cloud`) to [Render](https://render.com). Both apps share one Postgres instance.

Render's free tier was chosen over Fly because it doesn't require a card up front. Free Postgres expires after 90 days — fine for first-touch demos; swap to a paid tier or external Postgres (Neon, Supabase) before sticky users land.

## Prereqs

- Render account with GitHub connected (grant access to `phillipsio/relai` and `phillipsio/relai-cloud`).
- Resend account with a verified sending domain (free tier: 100/day). Without `RESEND_API_KEY` the cloud will log magic-link URLs to stdout, which works for testing but not for real users.
- A local clone of both repos with `DATABASE_URL` set in environment when running `db:push`.

## 1. Provision the database + OSS API

In the Render dashboard: **New → Blueprint**, point at `phillipsio/relai`. Render reads `render.yaml` and proposes:

- `relai-db` (Postgres, free plan)
- `relai-api` (Docker web service, free plan)

Apply the blueprint. Render will:

1. Create the Postgres instance.
2. Wire `DATABASE_URL` into `relai-api` automatically.
3. Generate `API_SECRET` (a random value — copy it from the env vars panel before leaving the page; you'll paste it as `SERVICE_ADMIN_TOKEN` in the cloud service).
4. Build the Docker image and start the service.

The first deploy will fail liveness because the schema isn't pushed yet. That's expected — handle it next.

## 2. Push the OSS schema

From the Render Postgres page, copy the **External Database URL**. Then locally:

```bash
cd ~/PhpstormProjects/relai
DATABASE_URL='<external-url>' pnpm --filter @getrelai/db db:push
```

Restart `relai-api` in the Render UI (or wait for the next health-check cycle). The API should come up clean now.

Smoke-test:

```bash
curl -i https://relai-api.onrender.com/health \
  -H "Authorization: Bearer <API_SECRET>"
```

Expect `200`.

## 3. Deploy the cloud dashboard

In Render: **New → Blueprint**, point at `phillipsio/relai-cloud`. The blueprint declares one Docker web service (`relai-cloud`) with several env vars marked `sync: false` — Render will prompt for each:

- `DATABASE_URL` — paste the External Database URL from step 1.
- `SERVICE_ADMIN_TOKEN` — paste the `API_SECRET` value from the OSS api.
- `RESEND_API_KEY` — from your Resend account.
- `EMAIL_FROM` — e.g. `Relai <login@yourdomain.com>` (must use a domain Resend has verified).

The blueprint also sets:

- `NEXTAUTH_URL=https://relai-cloud.onrender.com` — update in the UI after first deploy if Render assigned a different hostname.
- `RELAI_API_URL=https://relai-api.onrender.com` — same caveat if you renamed the api service.
- `NEXTAUTH_SECRET` — auto-generated.

Apply, wait for the build, then push the cloud schema:

```bash
cd ~/PhpstormProjects/relai-cloud
DATABASE_URL='<external-url>' pnpm db:push
```

The cloud's `drizzle.config.ts` filters to `cloud_*` tables, so this only adds the cloud schema without touching the OSS tables.

## 4. Verify end-to-end

1. Open `https://relai-cloud.onrender.com`.
2. Sign in with your email — Resend should deliver the magic link.
3. Create a project. Confirm it appears via the OSS API:
   ```bash
   curl https://relai-api.onrender.com/projects \
     -H "Authorization: Bearer <API_SECRET>"
   ```
4. Create an agent from the project page; copy the one-time token.
5. Re-create the agent with the same name from a second browser session — should be blocked by the 3-agent free-tier limit.

## Schema migrations after the first deploy

Render's free plan doesn't run a pre-deploy command. For any additive schema change:

```bash
# OSS schema
cd ~/PhpstormProjects/relai
DATABASE_URL='<external-url>' pnpm --filter @getrelai/db db:push

# Cloud schema
cd ~/PhpstormProjects/relai-cloud
DATABASE_URL='<external-url>' pnpm db:push
```

Column renames still need raw `ALTER TABLE ... RENAME COLUMN` first; see `AGENTS.md`.

## Free-tier gotchas

- **Cold starts.** Free web services spin down after ~15 min idle. First request after sleep takes 30–60 s. Acceptable for demos, not for live agent workers.
- **Postgres expires at 90 days.** Render will email a warning around day 75. Migrate to a paid tier or to Neon/Supabase before then; the only state to preserve is the database — both apps are stateless.
- **No `preDeployCommand`.** Schema pushes have to happen locally against the external URL. Document the URL in your password manager once.
- **Health checks.** `/health` is auth-gated and would 401. Render's default check just needs HTTP to respond; a 401 keeps the service marked healthy.
