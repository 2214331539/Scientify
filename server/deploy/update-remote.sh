#!/usr/bin/env bash
# Runs on the host as root (update.sh uploads and starts it): backs up the current code and the
# database, puts the new code in place, restarts the service and rolls back if it is unhealthy.
set -euo pipefail

app=/opt/scientify-collab/server
upload=/tmp/scientify-collab-src.tgz
stamp=$(date +%Y%m%d-%H%M%S)
backup=/root/backups/scientify-collab-$stamp
mkdir -p "$backup"

tar -czf "$backup/server.tgz" -C "$app" src package.json
runuser -u postgres -- pg_dump -Fc scientify > "$backup/scientify.dump"
echo "Backed up code and database to $backup"

healthy() {
  for _ in $(seq 1 15); do
    if curl -fsS http://127.0.0.1:8081/v1/health > /dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

tar -xzf "$upload" -C "$app"
chown -R root:root "$app"
systemctl restart scientify-collab
if ! healthy; then
  echo "The new version did not become healthy; restoring the previous one." >&2
  journalctl -u scientify-collab -n 30 --no-pager >&2 || true
  tar -xzf "$backup/server.tgz" -C "$app"
  systemctl restart scientify-collab
  healthy && echo "Previous version restored." >&2
  exit 1
fi

echo "Health: $(curl -fsS http://127.0.0.1:8081/v1/health)"
# The new sign-in routes answer (an empty request is refused with 400, not 404).
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' \
  -d '{}' http://127.0.0.1:8081/v1/auth/password-login)
echo "Password sign-in route: HTTP $code (400 expected)"
runuser -u postgres -- psql -d scientify -tAc \
  "SELECT 'password_hash column: ' || count(*) FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'password_hash'"
rm -f "$upload" /tmp/scientify-collab-update-remote.sh
echo "Done. Rollback: tar -xzf $backup/server.tgz -C $app && systemctl restart scientify-collab"
