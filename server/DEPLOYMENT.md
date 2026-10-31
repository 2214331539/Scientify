# Scientify collaboration service deployment

The service is intentionally small: PostgreSQL stores accounts, membership,
operation metadata and blob metadata; Alibaba OSS stores PDF and other binary
content; the node process handles authentication, sync and model streaming.
It should run as a separate systemd unit and database role from Learn2ai.

## PostgreSQL

Create a dedicated database and role as a PostgreSQL administrator, then put
the resulting connection string in a deployment-only `.env` file:

```sql
CREATE ROLE scientify_app LOGIN PASSWORD '<random-password>';
CREATE DATABASE scientify OWNER scientify_app;
```

The service creates its tables on startup. Do not point `DATABASE_URL` at the
Learn2ai database.

## Environment

Copy `.env.example` to `.env` and fill in a random 32+ character
`JWT_SECRET`, the dedicated `DATABASE_URL`, the OSS bucket credentials, and the
optional SMS/model gateway values. The provided Alibaba SMS names are accepted
through `ALIBABA_CLOUD_SMS_SIGN_NAME` and `ALIBABA_CLOUD_SMS_TEMPLATE_CODE`;
the access key aliases are also accepted. Keep this file outside Git.

Use `HOST=127.0.0.1` when Nginx is the public TLS endpoint. A reverse proxy
should forward `/v1/` to `http://127.0.0.1:8081/v1/` and preserve the
`Authorization` and `Content-Type` headers. The OSS signed URLs are returned
to the desktop and upload bytes directly to OSS, so Nginx never handles large
PDF bodies.

## First smoke check

```powershell
pnpm install --frozen-lockfile
$env:NODE_ENV = 'production'
pnpm start
curl https://<host>/v1/health
```

The health response reports database connectivity. Test SMS in a staging
environment with `SMS_DRY_RUN=true` and `DEV_SMS_CODE` before enabling paid
messages. Existing services on the host must remain untouched while this
service is brought up on its own port and database.
