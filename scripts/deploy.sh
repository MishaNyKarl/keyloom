#!/usr/bin/env bash
set -euo pipefail
release="${1:?commit SHA required}"
[[ "$release" =~ ^[a-f0-9]{40}$ ]] || exit 2
destination="/opt/keyloom/releases/$release"
mkdir -p "$destination"
tar -xzf "$HOME/release.tar.gz" -C "$destination"
/opt/keyloom-runtime/bin/node --check "$destination/server/app.mjs"
previous=$(readlink /opt/keyloom/current || true)
ln -sfn "$destination" /opt/keyloom/next
mv -Tf /opt/keyloom/next /opt/keyloom/current
sudo /bin/systemctl restart keyloom
for attempt in {1..15}; do
  if curl --fail --silent http://127.0.0.1:8791/health >/dev/null; then
    echo "Deployed $release"
    exit 0
  fi
  sleep 1
done
if [[ -n "$previous" ]]; then
  ln -sfn "$previous" /opt/keyloom/next
  mv -Tf /opt/keyloom/next /opt/keyloom/current
  sudo /bin/systemctl restart keyloom
fi
echo 'Health check failed; previous release restored when available' >&2
exit 1
