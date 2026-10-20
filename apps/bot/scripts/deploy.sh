#!/bin/sh
set -eu

# Run from the repository root. Recreate failed containers, but retain named volumes.
for attempt in 1 2 3; do
  if docker compose up --no-build --remove-orphans --force-recreate --wait --wait-timeout 180; then
    exit 0
  fi

  echo "Compose startup failed (attempt $attempt/3)." >&2
  docker compose ps --all >&2 || true
  docker compose logs --no-color --tail 100 >&2 || true

  if [ "$attempt" -lt 3 ]; then
    sleep 5
  fi
done

echo "Deployment failed after 3 startup attempts." >&2
exit 1
