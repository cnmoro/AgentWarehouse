# Sandboxed instance (Docker + gVisor)

A web terminal for someone who must not see this machine. The whole app runs in
a container under gVisor (runsc), which gives the container its own kernel, so
the user can have sudo inside without being root on the host. Their shells:

- see only their own host folder (mounted as their home);
- can `sudo apt install`, add users, etc.; everything installed persists across
  restarts and re-creation (/usr, /etc, /var, /opt, /root and /srv are host
  folders; only /tmp and new top-level folders are lost);
- reach the internet and the other tailnet devices (as this machine, so
  Tailscale ACLs for this machine apply; set ALLOW_TAILNET=0 in firewall.sh to
  block them), but not this machine itself, the LAN or any VPN;
- are reachable only on this machine's Tailscale IP.

## One-time machine setup

```sh
# gVisor, plus a Docker runtime that honours setuid (needed for sudo).
curl -fsSL https://gvisor.dev/archive.key | sudo gpg --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" | sudo tee /etc/apt/sources.list.d/gvisor.list
sudo apt-get update && sudo apt-get install -y runsc
# In /etc/docker/daemon.json:
#   "runtimes": { "runsc-suid": { "path": "/usr/bin/runsc", "runtimeArgs": ["--allow-suid"] } }
sudo systemctl reload docker        # reload, not restart: other containers keep running

# Firewall: root service that re-applies the rules whenever Docker starts.
sudo install -m 755 deploy/sandbox/firewall.sh /usr/local/sbin/sandbox-firewall.sh
sudo install -m 644 deploy/sandbox/sandbox-firewall.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now sandbox-firewall
# DNS forwarder on the sandbox bridge: tailnet names to MagicDNS, the rest to 1.1.1.1.
sudo install -m 644 deploy/sandbox/sandbox-dns.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now sandbox-dns
docker network create --subnet 172.30.53.0/24 -o com.docker.network.bridge.name=br-sandbox sandbox-net
```

## Per user (example: alice on port 17660)

```sh
docker build -t web-terminal-sandbox:alice --build-arg SANDBOX_USER=alice -f deploy/sandbox/Dockerfile .
DATA_DIR=data-17660 npm run set-user
deploy/sandbox/run.sh alice 17660
```

`run.sh` is safe to run again (after rebuilding the image to update the app, or
to change limits): it re-creates the container and keeps all data. Folders:
`/mnt/dados1/alice` (home), `/mnt/dados1/alice-system` (system folders, filled
from the image on the first run only), `data-17660/` (login and tabs).

Notes:
- DNS inside goes to sandbox-dns.service (dnsmasq on 172.30.53.1): Docker's
  built-in DNS does not work under gVisor, and MagicDNS alone does not answer
  public names for forwarded traffic. `run.sh` writes the container's
  resolv.conf (with the tailnet search domain) into the data folder.
- Docker's `--init` can't be used (its binary is mounted into the persistent
  /usr), so the image runs tini itself.
- Files the user creates are owned by uid 1000 on the host, or by root when
  created with sudo.
