#!/bin/sh
# Lets sandbox containers (Docker network on bridge br-sandbox) reach the
# internet only: not this machine, the LAN, the tailnet or any VPN.
# Idempotent; run as root after Docker starts (sandbox-firewall.service).
#
# The rules sit in mangle PREROUTING, which every packet from the container
# passes before routing and before the filter table. Filter-table rules would
# be too late: Tailscale's ts-forward chain runs first in FORWARD and accepts
# anything headed for the tailnet.
set -e
IF=br-sandbox
CHAIN=SANDBOX
iptables -t mangle -N "$CHAIN" 2>/dev/null || true
iptables -t mangle -F "$CHAIN"

# Replies to connections from outside (the published web port) pass.
iptables -t mangle -A "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
# New connections to this machine, private networks, the tailnet (100.64/10)
# and special ranges are dropped; the rest of the internet is allowed.
for net in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 \
           172.16.0.0/12 192.168.0.0/16 224.0.0.0/4 240.0.0.0/4; do
  iptables -t mangle -A "$CHAIN" -d "$net" -j DROP
done
# Addresses of this machine outside those ranges, if any.
for ip in $(ip -4 -o addr show | awk '{print $4}' | cut -d/ -f1); do
  iptables -t mangle -A "$CHAIN" -d "$ip" -j DROP
done

iptables -t mangle -C PREROUTING -i "$IF" -j "$CHAIN" 2>/dev/null || iptables -t mangle -I PREROUTING -i "$IF" -j "$CHAIN"
