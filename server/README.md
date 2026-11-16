# Scientify Collaboration Server

This service is the collaboration control plane. It owns authentication,
project membership, sync metadata, OSS signed URLs and the optional official
model gateway. It never runs a local Agent or experiment and it does not proxy
large files through the application process.

Copy `.env.example` to a deployment-only environment file. Do not commit that
file or place OSS, SMS, model or JWT secrets in the desktop application.

The first deployment uses a dedicated PostgreSQL database and an isolated
service/port. Existing services on the host must not share this database or
the Scientify environment file.

`HOST=127.0.0.1` is suitable behind Nginx; use `0.0.0.0` only when the port
is protected by a firewall. `OSS_ENDPOINT` is the region endpoint without the
bucket name (for example `oss-cn-beijing.aliyuncs.com`); the service builds
Alibaba OSS virtual-hosted signed URLs from `OSS_BUCKET`.

The desktop client stores short-lived access and refresh tokens in its local
Scientify data directory. Refresh tokens rotate on use. PDF and other binary
files are uploaded directly to OSS through short-lived signed URLs; the API
only stores blob metadata and never proxies their bytes.

The official model gateway exposes both `/v1/responses` (for the embedded
Agent) and `/v1/chat/completions` (for ordinary chat). Models, their prices
and the upstream channels that serve them live in the database and are managed
on the admin pages; channel keys are stored encrypted (`MODEL_KEY_SECRET`, or
a key derived from `JWT_SECRET` when it is unset, so rotating `JWT_SECRET`
then means re-entering the channel keys). On the first start with no channels,
the old `OFFICIAL_MODEL_*` settings are imported as a channel whose models stay
unlisted until an administrator prices them.

Every model request is metered: the plan must include the model, the account
needs points, and per-minute, concurrent and daily limits apply. The gateway
counts tokens from the upstream's usage report (estimating, and marking the
estimate, when there is none) and takes the points before the answer ends.
Only counts are stored, never what was asked or answered. Desktops call the
gateway with a per-device model token (`POST /v1/model-tokens`); access tokens
are still accepted for older clients and are metered the same way.

## Admin pages

`/admin` serves the pages in `admin/` (plain ES modules, no build step) and
their API under `/admin/api`. Sign-in takes the phone and the password; a
forgotten password is reset with an SMS code, which is sent only to
administrators. The session is an HttpOnly cookie scoped to `/admin`. Every
change is written to `admin_audit`. Grant access from the host (see
`DEPLOYMENT.md` section 8 for running it with the service's environment):

```bash
node src/admin-cli.mjs grant 13800000000 owner   # or viewer (read-only)
node src/admin-cli.mjs list
node src/admin-cli.mjs revoke 13800000000
```

Schema changes are numbered migrations in `src/migrations.mjs`, applied once
each at start.
