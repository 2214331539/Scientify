#!/usr/bin/env bash
set -euo pipefail
if [ -z "${APPLE_CERTIFICATE:-}${APPLE_CERTIFICATE_PASSWORD:-}${SCIENTIFY_SIGNING_IDENTITY:-}${APPLE_API_ISSUER:-}${APPLE_API_KEY:-}${APPLE_API_PRIVATE_KEY:-}" ]; then
  echo 'MACOS_SIGNING=adhoc' >> "$GITHUB_ENV"
  echo 'No Developer ID credentials configured; this build is an unnotarized preview.'
  exit 0
fi
for name in APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD SCIENTIFY_SIGNING_IDENTITY APPLE_API_ISSUER APPLE_API_KEY APPLE_API_PRIVATE_KEY; do
  if [ -z "${!name:-}" ]; then echo "Missing signing setting: $name" >&2; exit 1; fi
done
keychain="$RUNNER_TEMP/scientify-signing.keychain-db"
password="$(openssl rand -hex 24)"
echo "::add-mask::$password"
printf '%s' "$APPLE_CERTIFICATE" | base64 --decode > "$RUNNER_TEMP/scientify-signing.p12"
printf '%s' "$APPLE_API_PRIVATE_KEY" > "$RUNNER_TEMP/scientify-notary.p8"
chmod 600 "$RUNNER_TEMP/scientify-signing.p12" "$RUNNER_TEMP/scientify-notary.p8"
security create-keychain -p "$password" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$password" "$keychain"
security import "$RUNNER_TEMP/scientify-signing.p12" -k "$keychain" -P "$APPLE_CERTIFICATE_PASSWORD" -T /usr/bin/codesign
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$password" "$keychain"
security list-keychains -d user -s "$keychain" "$HOME/Library/Keychains/login.keychain-db"
{
  echo "APPLE_SIGNING_IDENTITY=$SCIENTIFY_SIGNING_IDENTITY"
  echo "APPLE_API_ISSUER=$APPLE_API_ISSUER"
  echo "APPLE_API_KEY=$APPLE_API_KEY"
  echo "APPLE_API_KEY_PATH=$RUNNER_TEMP/scientify-notary.p8"
  echo 'MACOS_SIGNING=developer-id'
} >> "$GITHUB_ENV"
