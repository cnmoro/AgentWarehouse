# Sandboxed instance (Docker)

A web terminal for someone who must not see this machine. The whole app runs in
a container: its shells see only one host folder (mounted as their home), have
no sudo or Docker access, and can reach the internet but not this machine, the
LAN, the tailnet or any VPN. The web port is published only on the Tailscale IP.

## Setup (example: user "alice" on port 17660)

```sh
# Image, with the login name as the Linux user inside the container.
docker build -t web-terminal-sandbox:alice --build-arg SANDBOX_USER=alice -f deploy/sandbox/Dockerfile .

# Firewall (once per machine): root service that re-applies the rules when Docker starts.
sudo install -m 755 deploy/sandbox/firewall.sh /usr/local/sbin/sandbox-firewall.sh
sudo install -m 644 deploy/sandbox/sandbox-firewall.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now sandbox-firewall
docker network create --subnet 172.30.53.0/24 -o com.docker.network.bridge.name=br-sandbox sandbox-net

# Their folder and login.
mkdir -p /mnt/dados1/alice && chmod 700 /mnt/dados1/alice
DATA_DIR=data-17660 npm run set-user

TS_IP=$(tailscale ip -4)
docker run -d --name web-terminal-alice --init --restart unless-stopped \
  --network sandbox-net --dns 1.1.1.1 --dns 8.8.8.8 \
  -p "$TS_IP:17660:17660" \
  -e PORT=17660 -e ALLOWED_HOSTS="$TS_IP,$(tailscale status --json | jq -r .Self.DNSName | sed 's/\.$//')" \
  -v /mnt/dados1/alice:/home/alice -v "$PWD/data-17660:/data" \
  --hostname sandbox --cap-drop ALL --security-opt no-new-privileges \
  --memory 8g --cpus 4 --pids-limit 1024 \
  web-terminal-sandbox:alice
```

Files the user creates belong to uid 1000 on the host. Rebuild the image and
recreate the container to update the app; the home folder and tabs are kept.
