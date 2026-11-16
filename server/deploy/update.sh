#!/usr/bin/env bash
# Updates the collaboration service's code and admin pages (src/ and admin/; its one dependency is unchanged).
# Run from Git Bash or a terminal that can reach the host:
#   bash server/deploy/update.sh [ssh-host]      (default: Tengxun_big_pp)
# SSH asks for the password twice (upload, then login) and sudo once more.
set -euo pipefail

host=${1:-Tengxun_big_pp}
here=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

tar -czf "$work/scientify-collab-src.tgz" -C "$here" src admin package.json
cp "$here/deploy/update-remote.sh" "$work/scientify-collab-update-remote.sh"
echo "Uploading to $host..."
scp "$work/scientify-collab-src.tgz" "$work/scientify-collab-update-remote.sh" "$host:/tmp/"
echo "Installing on $host (sudo will ask for the password)..."
ssh -t "$host" "sudo bash /tmp/scientify-collab-update-remote.sh"
