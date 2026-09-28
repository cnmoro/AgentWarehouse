#!/bin/sh
# Lets sandbox containers (Docker network on bridge br-sandbox) reach the
# internet and the other tailnet devices, but not this machine, the LAN or any VPN.
# Idempotent; run as root after Docker starts (sandbox-firewall.service).
#
# The rules sit in mangle PREROUTING, which every packet from the container
# passes before routing and before the filter table. Filter-table rules would
# be too late: Tailscale's ts-forward chain runs first in FORWARD and accepts
# anything headed for the tailnet.
set -e
IF=br-sandbox
CHAIN=SANDBOX
# 1 = sandboxes may reach other devices on the tailnet (100.64.0.0/10), as this
# machine; 0 = tailnet blocked too.
ALLOW_TAILNET=${ALLOW_TAILNET:-1}

iptables -t mangle -N "$CHAIN" 2>/dev/null || true
iptables -t mangle -F "$CHAIN"

# Replies to connections from outside (the published web port) pass.
iptables -t mangle -A "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
# This machine itself, on any of its addresses (checked per packet, so
# addresses that appear later, like the Tailscale IP at boot, are covered).
# Except DNS on the sandbox bridge (sandbox-dns.service).
iptables -t mangle -A "$CHAIN" -d 172.30.53.1 -p udp --dport 53 -j RETURN
iptables -t mangle -A "$CHAIN" -d 172.30.53.1 -p tcp --dport 53 -j RETURN
iptables -t mangle -A "$CHAIN" -m addrtype --dst-type LOCAL -j DROP
if [ "$ALLOW_TAILNET" = 1 ]; then
  iptables -t mangle -A "$CHAIN" -d 100.64.0.0/10 -j RETURN
fi
# New connections to private networks (LAN, VPNs) and special ranges are
# dropped; the rest of the internet is allowed.
for net in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 \
           172.16.0.0/12 192.168.0.0/16 224.0.0.0/4 240.0.0.0/4; do
  iptables -t mangle -A "$CHAIN" -d "$net" -j DROP
done

iptables -t mangle -C PREROUTING -i "$IF" -j "$CHAIN" 2>/dev/null || iptables -t mangle -I PREROUTING -i "$IF" -j "$CHAIN"
