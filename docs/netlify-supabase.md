# Running SignuDoc on Netlify with Supabase

This fork runs SignuDoc on Netlify, with its database and files in a
Supabase project, including one that another app already uses. Email can go
through SendGrid instead of Resend. The app, API and webhooks work as
described in the rest of the docs.

| Vercel install    | This setup                                         |
| ----------------- | -------------------------------------------------- |
| Vercel hosting    | Netlify site (Next.js runtime, Node 24)            |
| Neon Postgres     | Supabase Postgres, in its own `signudoc` schema    |
| Vercel Blob       | Supabase Storage, a private `signudoc` bucket      |
| Resend email      | SendGrid (`SENDGRID_API_KEY`), or Resend as before |
| Vercel crons      | Netlify scheduled functions (`netlify/functions`)  |
| Daily Blob backup | Not used: Supabase backs up the database itself    |

## 1. Prepare the Supabase project (once)

1. Open the project's **SQL editor**.
2. Paste [`db/supabase-setup.sql`](../db/supabase-setup.sql), replace
   `REPLACE-WITH-A-LONG-RANDOM-PASSWORD` with a new password
   (`openssl rand -hex 24`), and run it.

   This makes a login role `signudoc_app`, a schema `signudoc` it owns, and a
   private Storage bucket `signudoc`. The role can use nothing outside its
   schema, and the schema is not one the project's API serves, so neither
   app can read the other's tables.

3. **Do not** add `signudoc` to Settings, API, Exposed schemas.

## 2. Create the Netlify site

Import this repository as a new site. `netlify.toml` sets the build, Node 24
and the scheduled functions. Then add these environment variables (Site
configuration, Environment variables), for all scopes:

| Variable                    | Value                                                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`              | The **transaction** pooler, as the new role: `postgres://signudoc_app.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres` |
| `DATABASE_URL_UNPOOLED`     | The **session** pooler, same user: the same URL with port `5432`. Used only by migrations, which need a session for their lock.                  |
| `DATABASE_POOL_MAX`         | `3`. Each function instance keeps at most this many connections open.                                                                            |
| `SUPABASE_URL`              | `https://<project-ref>.supabase.co`                                                                                                              |
| `SUPABASE_SERVICE_ROLE_KEY` | The project's service role (or secret) key. Server-side only.                                                                                    |
| `SUPABASE_STORAGE_BUCKET`   | Optional, `signudoc` by default.                                                                                                                 |
| `APP_URL`                   | The site's public `https://` address.                                                                                                            |
| `BETTER_AUTH_SECRET`        | `openssl rand -hex 32`                                                                                                                           |
| `CRON_SECRET`               | `openssl rand -hex 32`. The scheduled functions send it; the job routes require it.                                                              |
| `SENDGRID_API_KEY`          | A SendGrid API key. Mail Send access is enough to send; Full Access also lets Settings check the domain. (Or `RESEND_API_KEY` for Resend.)       |
| `EMAIL_FROM`                | The sender, at a domain authenticated in SendGrid, such as `Privion <sign@priviontech.com>`. Can also be set in Settings instead.                |

`DATABASE_SCHEMA=signudoc` is already set for the build in `netlify.toml`;
the migrator creates every table there. The app itself finds them through
the role's `search_path`.

Deploy. The build runs the migrations before `next build`. Deploy previews
and branch deploys skip them, since they share the production database.

## 3. Finish setup in the app

Open the site. The first visit walks through creating the administrator.
Then, under Settings, Organization:

- **API keys**: make a key for each app that sends documents.
- **Webhooks**: add the receiving app's endpoint.

## How the pieces map

- **Files.** `STORAGE_DRIVER` resolves to `supabase` whenever
  `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set
  (`src/lib/services/storage/supabase.ts`). Reads always go through the app,
  which checks access first; the bucket is private.
- **PDFs over the request limit.** Netlify caps a function request at 6 MB,
  so, as with Vercel Blob, the upload page and `POST /api/v1/uploads` hand
  out a signed Supabase upload URL for one key in the user's pending
  folder, and the app reads the file back and validates it. Supabase signed
  upload URLs last two hours. Uploads that are never picked up are deleted
  by the daily cleanup after a day.
- **Scheduled jobs.** `netlify/functions/retention-job.mts` calls
  `/api/internal/retention` daily; `webhook-retries.mts` calls
  `/api/internal/webhooks` every five minutes, so webhook retries are not
  held to once a day. Both send `CRON_SECRET`.
- **Backups.** The Blob backup job does nothing on this setup. Use the
  Supabase project's own backups (daily on Pro, point-in-time as an add-on);
  Storage objects are not part of database backups, so copy the bucket
  separately if you need file backups.

## Pulling upstream releases

The migration files are untouched; `db/migrate.mjs` rewrites their
`public.` to `DATABASE_SCHEMA` as it applies them. Runtime queries name no
schema. So an upstream merge normally needs nothing more than:

```bash
git fetch upstream
git merge upstream/main
```

If a new upstream query hard-codes `public.`, it will fail on this setup
with "relation does not exist": remove the prefix.

## Email through SendGrid

Setting `SENDGRID_API_KEY` (and no `RESEND_API_KEY`) sends every email
through SendGrid's Mail Send API (`src/lib/services/email-sendgrid.ts`);
`EMAIL_DRIVER=sendgrid` forces it. The sender's domain must be authenticated
in SendGrid (Settings, Sender Authentication). Settings, Organization, Email
setup reports what SendGrid says about the domain, or, with a send-only key,
asks for a test email.

Click and open tracking are turned off on every message, whatever the
SendGrid account's defaults, so signing links reach signers unchanged
rather than through SendGrid's redirect. SendGrid has no idempotency key, so
only a refused-for-rate (429) send is retried.
