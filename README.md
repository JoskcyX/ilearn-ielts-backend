# ILEARN Spaces: Backend API

The REST API behind the IELTS practice platform. It handles accounts and roles, tests and questions, exam attempts, file uploads, and AI scoring for Writing and Speaking.

**Stack:** Node 20+, Express, TypeScript, Drizzle ORM, PostgreSQL (Neon), JWT in an httpOnly cookie, OpenAI for assessment, S3-compatible object storage (Neon Object Storage) with a local-disk fallback for development.

The frontend lives in `../frontend` and talks to this API only through its own `/api/*` and `/uploads/*` proxy routes. See `../frontend/README.md`.

---

## How it fits together

```
Browser ──> Netlify (frontend) ──/api/*, /uploads/*──> Render (this API) ──> Neon Postgres
                                                                        └──> Neon Object Storage (bucket)
                                                                        └──> OpenAI
```

- The bucket is **private**. Uploaded files are streamed through the API at `/uploads/<key>` (with range support, so audio can seek).
- Database rows store a storage **key** (for example `audio/<uuid>.mp3`), never a full URL, so you can change storage providers without rewriting data.

## Project layout

```
src/
  server.ts            entry point
  app.ts               Express app: helmet, CORS, cookies, /health, routes
  routes/              auth, admin, student, teacher, classes, passages, question-groups,
                       questions, mock-tests, exam, audio, media
  lib/                 env.ts (validated config), storage.ts (S3 + local), jwt.ts,
                       ai-assessment-pipeline.ts, password.ts, validations/
  middleware/          auth / role checks
  db/                  schema.ts, migrations/, migrate.ts, seed.ts, create-admin.ts,
                       upload-local-to-bucket.ts
render.yaml            optional Render Blueprint (see "Deploy")
```

## Environment variables

Copy `.env.example` to `.env` for local work. **Never commit `.env`.**

| Variable | Required | What it is |
|---|---|---|
| `DATABASE_URL` | yes | Neon connection string |
| `AUTH_SECRET` | yes | Long random string. The frontend needs the **same** value |
| `FRONTEND_ORIGIN` | yes in prod | Allowed browser origin(s), comma-separated (e.g. `https://your-site.netlify.app`) |
| `OPENAI_API_KEY` | for scoring | Writing and Speaking assessment and transcription |
| `OPENAI_MODEL` | no | Defaults to `gpt-4.1` |
| `STORAGE_BUCKET` | for the bucket | Bucket name from the Neon Console. **Leaving this empty switches to local disk** |
| `STORAGE_ENDPOINT` | for the bucket | `https://br-xxxx.storage.<region>.aws.neon.tech` |
| `STORAGE_ACCESS_KEY_ID` / `STORAGE_SECRET_ACCESS_KEY` | for the bucket | Neon storage credentials |
| `STORAGE_REGION` | for the bucket | Must match your Neon region, e.g. `us-east-2` |
| `UPLOAD_DIR` | no | Local fallback folder, default `./uploads` |
| `NODE_ENV` | prod | Set `production` (turns on `secure` cookies) |
| `PORT` | no | Default `4000` (Render sets this for you) |
| `SEED_ORG_NAME` | no | Organization name used by seed/create-admin |

Neon's own variable names also work: `AWS_ENDPOINT_URL_S3`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_REGION` are used when the matching `STORAGE_*` value is empty. `STORAGE_BUCKET` has no `AWS_*` equivalent.

## Run locally

```bash
npm install
cp .env.example .env        # fill in DATABASE_URL, AUTH_SECRET, ...
npm run db:migrate          # create/upgrade tables
npm run db:seed             # LOCAL ONLY: demo users, password "password123"
npm run dev                 # http://localhost:4000  (health: /health)
```

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Dev server with reload |
| `npm run build` / `npm start` | Compile to `dist/` / run compiled server |
| `npm run typecheck` | TypeScript check |
| `npm run db:generate` | Generate a migration after editing `schema.ts` |
| `npm run db:migrate` | Apply migrations (dev, via tsx) |
| `npm run db:migrate:prod` | Apply migrations from compiled code (used on Render) |
| `npm run db:seed` | Demo data. **Never run against production** |
| `npm run db:create-admin` | Create the first real admin (see below) |
| `npm run db:studio` | Browse the database in Drizzle Studio |
| `npm run storage:upload-local` | Copy local `uploads/` files into the bucket (same keys) |

## File storage

- **Bucket mode** is on when `STORAGE_BUCKET` is set (plus endpoint and keys). Uploads go to Neon Object Storage.
- **Local mode** is the fallback when it is empty. Files go to `UPLOAD_DIR`. Render's disk is wiped on every deploy, so never rely on this in production.
- Moving existing local files into the bucket: set the bucket variables, then run `npm run storage:upload-local`. Keys are preserved, so existing database rows keep working.

## Deploy to Render (with Neon)

Do this **before** the frontend, because the frontend needs your Render URL.

**1. Neon.** In the Neon Console open **Connect** and copy the connection string (the pooled one is fine). If you get an error mentioning `channel_binding`, delete `&channel_binding=require` from the string. Note your bucket name under **Storage** and have the endpoint and keys handy.

**2. Push the project to GitHub** with `backend/` and `frontend/` as folders in one repo. Check that `.env` is not committed.

**3. Create the service.** Render dashboard, **New +**, **Web Service**, connect the repo:

| Field | Value |
|---|---|
| Name | `ielts-api` |
| Region | **Ohio** (closest to Neon `us-east-2`) |
| Root Directory | `backend` |
| Runtime | Node |
| Build Command | `npm install --include=dev && npm run build` |
| Start Command | `npm run db:migrate:prod && npm start` |
| Health Check Path | `/health` |
| Instance type | Free to try; **Starter for real use** (Free sleeps after about 15 minutes idle) |

**4. Environment variables** (Advanced, then Add Environment Variable):

```
NODE_ENV=production
NODE_VERSION=20
DATABASE_URL=<Neon connection string>
AUTH_SECRET=<output of: openssl rand -base64 32>
FRONTEND_ORIGIN=https://placeholder.netlify.app     # update after the frontend is live
OPENAI_API_KEY=<your key>
OPENAI_MODEL=gpt-4.1
STORAGE_ENDPOINT=<Neon storage endpoint>
STORAGE_BUCKET=<bucket name>
STORAGE_ACCESS_KEY_ID=<nak_live_...>
STORAGE_SECRET_ACCESS_KEY=<nsk_live_...>
STORAGE_REGION=us-east-2
SEED_ORG_NAME=ILEARN Spaces
```

Keep the `AUTH_SECRET` value somewhere safe: Netlify needs the identical one.

**5. Deploy** and open `https://<service>.onrender.com/health`. You should see `{"ok":true}`. Migrations run automatically on each start.

**6. Create your first admin.** Render's free plan has no shell, so run this from your own computer, pointed at the Neon database:

```bash
cd backend
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a-long-password' ADMIN_NAME='Your Name' \
DATABASE_URL='<Neon connection string>' npm run db:create-admin
```

Public sign-up always creates **students**, and registration needs an organization to exist, which this command creates.

**7. After the frontend is deployed**, set `FRONTEND_ORIGIN` on Render to the Netlify URL and save (Render redeploys).

*Optional:* `render.yaml` is a Blueprint for the same setup. Render only reads it from the **repo root**, so move it there (it already has `rootDir: backend`) and use **New +, Blueprint**.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Uploads vanish after a deploy | `STORAGE_BUCKET` is empty, so files are on Render's temporary disk |
| `403` or signature errors from the bucket | Wrong `STORAGE_REGION` (use your Neon region, not `auto`) or wrong keys |
| Audio plays but cannot seek | Requests are not reaching `/uploads/*` through the proxy; check the frontend `BACKEND_URL` |
| "No organization is configured" on sign-up | Run `npm run db:create-admin` once |
| Logged out immediately in production | `NODE_ENV` is not `production`, or `AUTH_SECRET` differs from the frontend's |
| First request after idle is very slow or times out | Free instance was asleep; use Starter |
| Boot fails: "Invalid environment" | A required variable is missing; the log names it |
