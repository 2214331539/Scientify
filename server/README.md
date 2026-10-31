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
Agent) and `/v1/chat/completions` (for ordinary chat). Set
`OFFICIAL_MODEL_ENDPOINT` to an upstream Responses endpoint or its API root;
optionally set `OFFICIAL_MODEL_CHAT_ENDPOINT` when chat uses a different
upstream. The desktop sends the user's collaboration access token to these
routes, while the provider key stays on the server.
