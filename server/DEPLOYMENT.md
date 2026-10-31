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

These values belong only on the collaboration server. Desktop release and
local Mac/Windows build machines must not receive database, JWT, OSS or SMS
secrets. The desktop uses the managed service URL for normal builds and exposes
an advanced self-hosted URL override for development.

Use `HOST=127.0.0.1` when Nginx is the public TLS endpoint. A reverse proxy
should forward `/v1/` to `http://127.0.0.1:8081/v1/` and preserve the
`Authorization` and `Content-Type` headers. The OSS signed URLs are returned
to the desktop and upload bytes directly to OSS, so Nginx never handles large
PDF bodies.

The repository includes `deploy/scientify-collab.service` and
`deploy/nginx-scientify.conf` as the smallest production layout. Install the
application under `/opt/scientify-collab`, keep secrets in
`/etc/scientify-collab.env`, and include the Nginx location inside the existing
TLS server block for the public collaboration host. The service account needs
no shell, sudo or access to the Learn2ai data directory.

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
