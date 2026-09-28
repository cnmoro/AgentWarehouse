# A web terminal whose shells can only see one folder of the host. The user
# has sudo inside; run it under gVisor (runsc) so that root stays in the sandbox.
# See deploy/sandbox/README.md.
FROM node:22-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl wget ca-certificates vim nano less procps htop tmux \
      python3 python3-pip python3-venv build-essential unzip zip jq ripgrep sudo tini \
    && rm -rf /var/lib/apt/lists/*

# The image's "node" user (uid 1000) becomes the sandbox user, so files in the
# shared folder belong to uid 1000 on the host too.
ARG SANDBOX_USER=sandbox
RUN groupmod -n "$SANDBOX_USER" node \
    && usermod -l "$SANDBOX_USER" -d "/home/$SANDBOX_USER" -m node \
    && echo "$SANDBOX_USER ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/sandbox \
    && chmod 440 /etc/sudoers.d/sandbox

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js ./
COPY lib lib
COPY public public
COPY scripts scripts
COPY deploy/sandbox/entrypoint.sh /usr/local/bin/entrypoint.sh

ENV HOME=/home/$SANDBOX_USER \
    USER=$SANDBOX_USER \
    SHELL=/bin/bash \
    DATA_DIR=/data \
    HOST=0.0.0.0 \
    NPM_CONFIG_PREFIX=/home/$SANDBOX_USER/.npm-global \
    PATH=/home/$SANDBOX_USER/.npm-global/bin:/home/$SANDBOX_USER/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
USER $SANDBOX_USER
# tini reaps orphaned processes (Docker's --init can't be used: its binary is
# mounted into /usr, which is a persistent folder here).
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
