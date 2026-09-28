#!/bin/sh
# (Re)create a sandbox container. Safe to run again: home, tabs and everything
# installed with apt (/usr, /etc, /var, /opt, /root, /srv) live in host folders
# and are kept. Only /tmp and new top-level folders are lost on re-creation.
#
#   deploy/sandbox/run.sh <user> <port>
#
# Folders (override with HOME_DIR, SYSTEM_DIR, DATA_DIR):
#   /mnt/dados1/<user>           his home
#   /mnt/dados1/<user>-system    persistent system folders
#   <repo>/data-<port>           login and tabs (create with: DATA_DIR=data-<port> npm run set-user)
set -eu
USER_NAME=$1
PORT=$2
REPO=$(cd "$(dirname "$0")/../.." && pwd)
IMAGE=web-terminal-sandbox:$USER_NAME
NAME=${NAME:-web-terminal-$USER_NAME}
HOME_DIR=${HOME_DIR:-/mnt/dados1/$USER_NAME}
SYSTEM_DIR=${SYSTEM_DIR:-/mnt/dados1/$USER_NAME-system}
DATA_DIR=${DATA_DIR:-$REPO/data-$PORT}
SYSTEM_PARTS="etc opt root srv usr var"
TS_IP=$(tailscale ip -4)
TS_NAME=$(tailscale status --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).Self.DNSName.replace(/\.$/,"")))')

[ -f "$DATA_DIR/users.json" ] || { echo "No login yet: DATA_DIR=$DATA_DIR npm run set-user" >&2; exit 1; }
mkdir -p "$HOME_DIR" && chmod 700 "$HOME_DIR"

# First run only: copy the image's system folders out, keeping owners and modes.
# SYSTEM_DIR is root-only, so check it as root. Never copy over existing data:
# that would put the image's /etc and /var back over the user's.
if ! sudo test -e "$SYSTEM_DIR/.seeded"; then
  if sudo test -d "$SYSTEM_DIR" && [ -n "$(sudo ls -A "$SYSTEM_DIR")" ]; then
    echo "$SYSTEM_DIR is not empty but has no .seeded marker; refusing to overwrite it." >&2
    exit 1
  fi
  sudo mkdir -p "$SYSTEM_DIR" && sudo chmod 700 "$SYSTEM_DIR"
  docker run --rm --user 0 --entrypoint sh -v "$SYSTEM_DIR:/seed" "$IMAGE" \
    -c "cp -a $(for p in $SYSTEM_PARTS; do printf '/%s ' "$p"; done) /seed/ && touch /seed/.seeded"
fi

# DNS through sandbox-dns.service on the bridge; the search domain makes bare
# tailnet names ("ssh bigdata") work.
printf 'nameserver 172.30.53.1\nsearch %s\noptions edns0\n' "${TS_NAME#*.}" > "$DATA_DIR/resolv.conf"

MOUNTS=""
for p in $SYSTEM_PARTS; do MOUNTS="$MOUNTS -v $SYSTEM_DIR/$p:/$p"; done

docker rm -f "$NAME" >/dev/null 2>&1 || true
# shellcheck disable=SC2086
docker run -d --name "$NAME" --runtime="${RUNTIME:-runsc-suid}" --restart unless-stopped \
  --network sandbox-net \
  -p "$TS_IP:$PORT:$PORT" \
  -e PORT="$PORT" -e ALLOWED_HOSTS="$TS_IP,$TS_NAME" \
  $MOUNTS \
  -v "$DATA_DIR/resolv.conf:/etc/resolv.conf:ro" \
  -v "$HOME_DIR:/home/$USER_NAME" \
  -v "$DATA_DIR:/data" \
  --hostname sandbox \
  --memory 8g --cpus 4 --pids-limit 1024 \
  "$IMAGE"
