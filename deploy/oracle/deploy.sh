#!/bin/sh
# Deploy the current checkout of this fork to the Oracle box.
#
# Run on the server from the repo root (the CI forced-command wrapper
# ~/bin/actual-deploy syncs to origin/master first, then execs this).
# Builds the sync-server image, backs up the data dir, swaps the
# container, and rolls back to the previous image if /health fails.
set -eu

NAME=my_actual_budget
DATA=/home/opc/actualbudget
BACKUPS=/home/opc/actualbudget-backups
PORT=127.0.0.1:5006:5006
# Plaid keys (PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV, PLAID_TOKEN_KEY).
# Lives outside the repo; PLAID_TOKEN_KEY must stay the same across deploys
# or stored bank tokens can no longer be decrypted.
ENV_FILE=/home/opc/actual-plaid.env
SHA=$(git rev-parse --short HEAD)
IMAGE=actual-fork:$SHA

echo "==> Building $IMAGE"
sudo docker build -f sync-server.Dockerfile -t "$IMAGE" -t actual-fork:latest .

echo "==> Backing up $DATA"
mkdir -p "$BACKUPS"
BACKUP="$BACKUPS/actualbudget-$(date +%Y%m%d-%H%M%S)-$SHA.tgz"
sudo tar czf "$BACKUP" -C "$(dirname "$DATA")" "$(basename "$DATA")"
sudo chown "$(id -u):$(id -g)" "$BACKUP"
ls -1t "$BACKUPS"/*.tgz | tail -n +11 | xargs -r rm -f   # keep newest 10

PREV=$(sudo docker inspect --format '{{.Config.Image}}' "$NAME" 2>/dev/null || true)

run() {
  set --  "$1"
  if [ -f "$ENV_FILE" ]; then
    set -- --env-file "$ENV_FILE" "$1"
  else
    echo "    (no $ENV_FILE; starting without Plaid keys)" >&2
  fi
  sudo docker rm -f "$NAME" >/dev/null 2>&1 || true
  sudo docker run -d --name "$NAME" --restart unless-stopped \
    -p "$PORT" -v "$DATA:/data" "$@" >/dev/null
}

healthy() {
  for _ in $(seq 1 30); do
    curl -fsS http://127.0.0.1:5006/health >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}

echo "==> Starting $IMAGE (previous: ${PREV:-none})"
run "$IMAGE"
if healthy; then
  echo "==> Deployed $SHA"
  sudo docker image prune -f >/dev/null
  exit 0
fi

echo "!!  $IMAGE failed health check" >&2
sudo docker logs --tail 50 "$NAME" >&2 || true
if [ -n "$PREV" ]; then
  echo "==> Rolling back to $PREV" >&2
  run "$PREV"
  healthy && echo "==> Rollback healthy" >&2
fi
exit 1
