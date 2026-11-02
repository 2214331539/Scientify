# Scientify collaboration service deployment

The service is small: PostgreSQL stores accounts, membership and the current
state of every synced file and record; Alibaba OSS stores file contents; one
Node process handles sign-in, sync and the optional model gateway. Desktop
clients upload and download files straight to OSS through short-lived signed
URLs, so file bytes never pass through this server.

The steps below were run on Ubuntu 26.04 (Node 22, PostgreSQL 18, Nginx 1.28).
Everything comes from the distribution archive except the application itself.

## 0. Before you start

- **Reachability from mainland China.** Check that users can reach the host
  before deploying. An overseas IP can be blocked for TCP while ping still
  works: test TCP to port 22 from mainland probes (for example the Globalping
  API) and from the host to `dysmsapi.aliyuncs.com:443`, which SMS sign-in
  needs. Replace the IP if either fails.
- **Firewall.** The cloud firewall or security group must allow TCP 80 (for
  certificate validation) and 443.
- **OSS bucket and key.** Create a private bucket and a RAM user whose key can
  only use it. The key needs at least this policy:

  ```json
  {
    "Version": "1",
    "Statement": [
      {
        "Effect": "Allow",
        "Action": ["oss:PutObject", "oss:GetObject", "oss:DeleteObject"],
        "Resource": ["acs:oss:*:*:<bucket>/*"]
      }
    ]
  }
  ```

  Without it OSS answers `AccessDenied ... ImplicitDeny`. The service signs
  URLs with signature V4, which new accounts and new buckets require.
- **SMS.** An approved signature and verification-code template in Alibaba
  Cloud SMS, and a RAM key that may only send SMS.

## 1. Packages, account and folders

```bash
sudo apt-get install -y postgresql nginx nodejs acme.sh
sudo useradd --system --home-dir /opt/scientify-collab --shell /usr/sbin/nologin scientify
sudo mkdir -p /opt/scientify-collab/server /var/www/acme
```

Node 20 or newer is required. certbot 4.0 cannot issue IP-address
certificates; acme.sh 3.1 can.

## 2. Database

Use a dedicated role and database; never share another service's database.

```bash
pw=$(openssl rand -hex 24)
sudo -u postgres psql -c "CREATE ROLE scientify_app LOGIN PASSWORD '$pw'"
sudo -u postgres createdb -O scientify_app scientify
```

The service creates and upgrades its tables on start.

## 3. Environment

Write `/etc/scientify-collab.env`, mode 600, owned by `scientify`. Start
from `.env.example`. Required:

- `NODE_ENV=production`, `HOST=127.0.0.1`, `PORT=8081`, `TRUST_PROXY=true`
- `DATABASE_URL=postgresql://scientify_app:<pw>@127.0.0.1:5432/scientify`
- `JWT_SECRET`, from `openssl rand -hex 32`
- `OSS_BUCKET`, `OSS_REGION` (for example `cn-hangzhou`), `OSS_ENDPOINT`
  (`https://oss-cn-hangzhou.aliyuncs.com`), `OSS_ACCESS_KEY_ID`,
  `OSS_ACCESS_KEY_SECRET`
- `SMS_ACCESS_KEY_ID`, `SMS_ACCESS_KEY_SECRET`, `SMS_SIGN_NAME`,
  `SMS_TEMPLATE_CODE`

For test accounts set `DEV_SMS_CODE` together with `DEV_SMS_PHONES` (a
comma-separated list). Those numbers sign in with the fixed code and receive
no SMS. Production refuses to start with a fixed code but no list, because
the code would otherwise sign anyone in.

Secrets live only in this file. Desktop builds need nothing but the public
service address.

## 4. Application

Build a flat dependency folder from the lockfile on a development machine and
copy it, so the server never fetches packages:

```bash
pnpm install --prod --frozen-lockfile --ignore-workspace --config.node-linker=hoisted
tar -czf server.tgz package.json pnpm-lock.yaml src node_modules
# on the host
sudo tar -xzf server.tgz -C /opt/scientify-collab/server
sudo chown -R root:root /opt/scientify-collab/server
```

The code stays owned by root; the service account only reads it.

## 5. Service

```bash
sudo install -m 644 deploy/scientify-collab.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now scientify-collab
curl http://127.0.0.1:8081/v1/health   # {"ok":true,...,"database":"ok"}
```

## 6. Nginx and HTTPS

Install the three files under `deploy/nginx/`:

| File | Destination |
| --- | --- |
| `scientify-limits.conf` | `/etc/nginx/conf.d/`: per-address limits (sign-in codes 6/min, API 30/s) |
| `scientify-proxy.conf` | `/etc/nginx/snippets/`: proxy headers, including `X-Real-IP` |
| `scientify-site.conf` | `/etc/nginx/sites-available/scientify`, linked into `sites-enabled` |

The site serves `/.well-known/acme-challenge/` from `/var/www/acme` on port
80 and the API on 443 with a 16 MiB body limit; Nginx's default 1 MiB would
reject larger sync pushes.

On a host that already serves other sites, do not replace their server
blocks. Add the two API `location` blocks to the existing TLS server for the
collaboration host name instead, and keep their certificates as they are.

Issue the certificate while only the port-80 block is active, then enable
the 443 block:

```bash
sudo acme.sh --issue --server letsencrypt -d <ip-or-domain> -w /var/www/acme \
  --cert-profile shortlived --days 3          # IP certificates: shortlived profile
sudo mkdir -p /etc/nginx/tls && sudo chmod 700 /etc/nginx/tls
sudo acme.sh --install-cert -d <ip-or-domain> --ecc \
  --key-file /etc/nginx/tls/scientify.key --fullchain-file /etc/nginx/tls/scientify.crt \
  --reloadcmd "systemctl reload nginx"
```

For a domain, drop `--cert-profile shortlived --days 3`. Let's Encrypt IP
certificates last 160 hours, so renewal must be automatic and must not run
more often than needed; the duplicate-certificate limit is five a week.
Install the timer, which checks twice a day and renews only when due:

```bash
sudo install -m 644 deploy/acme-renew.service deploy/acme-renew.timer /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now acme-renew.timer
```

## 7. Smoke checks

1. `curl https://<host>/v1/health` from outside the host reports `database: ok`.
2. A test number signs in with `DEV_SMS_CODE`; a real number receives an SMS.
3. Two desktop clients on the same account open one cloud project; a note,
   a PDF and a code file edited on one device appear on the other.

Point desktop builds at the service with `SCIENTIFY_COLLAB_ENDPOINT` at build
time, or change the address under Settings → Collaboration.
