# Installing Agent Warehouse (instructions for an AI agent)

This file is written for a coding agent (Claude Code, Codex, opencode or similar). The user gives you one request, for example:

> Install AgentWarehouse for me, instructions in INSTALL.md

Do the whole installation yourself, in order, checking each step. Only stop to ask the user when this file says so, or when you cannot decide something safely. When you finish, give the report in [Final report](#final-report).

## Rules

- **Run as the user's normal account, not root.** Every terminal the app opens is a real shell of that account. Use `sudo` only for installing system packages, and say what you are installing before you do it.
- **The app must never be reachable from the public internet.** It gives a shell to anyone who logs in. Bind it to Tailscale or to `127.0.0.1`. Never set `HOST=0.0.0.0`, never use `tailscale funnel`, never open a firewall port to the world.
- **Do not touch what is already there.** Do not change an existing Tailscale serve configuration, another service on the same port, an existing VNC server or the user's shell files. Look first, and add next to it.
- **Secrets stay out of files, logs and git.** The login password, the VNC password and everything under `data/` must not be committed or written into this repository, the shell history or your own notes. Show a generated password to the user once, in the final report.
- **Ask before anything that is hard to undo:** replacing a running instance, deleting a folder, changing network settings, and the `sudo` commands in step 2. If the user already told you to go ahead with everything, you may proceed.
- Do not skip a check because the previous step "should have worked". If a check fails, read the error, fix it, and run the check again.

## What you are installing

A Node.js web server (xterm.js and node-pty) that serves a page with terminals, saved SSH connections, a file explorer and a remote desktop. Login is by email and password. By default it listens only on the machine's Tailscale address, port 7681. The README has the full feature list and the screenshots.

## 1. Look at the machine

Run these and keep the answers; later steps depend on them.

```sh
uname -sr; cat /etc/os-release | head -3
id -un; echo "$HOME"
node -v; npm -v
systemctl --user is-system-running      # needs a systemd user session: "running" or "degraded" is fine
tailscale status 2>&1 | head -3         # is Tailscale installed, up and logged in?
ss -ltn | grep -E ':(7681|5901)\b'      # is something already on the app's port or on the VNC port?
ls -d ~/AgentWarehouse 2>/dev/null; systemctl --user list-units 'web-terminal*' --no-legend
```

Decide:

- **Already installed?** If the folder or a `web-terminal` unit exists, this is an update, not an install: go to [Updating](#updating) and do not create a second copy without asking.
- **Not Linux, or no `systemctl --user`?** The app itself runs anywhere Node and a C++ toolchain work, but this file only covers Linux with systemd. Tell the user what is missing and how you would run it instead (a foreground `npm start`), and ask.
- **Network mode.**
  - Tailscale is up: use the default (no `HOST`). The app binds to the Tailscale IPv4 address and refuses other networks.
  - Tailscale is not installed or not logged in: ask the user whether to install it (recommended; they must open the login link that `sudo tailscale up` prints) or to run local-only with `HOST=127.0.0.1` and reach it through an SSH tunnel (`ssh -L 7681:127.0.0.1:7681 user@machine`).

## 2. Install the system packages

Needed to start: Node.js 22.9 or later, npm, and a C++ toolchain (node-pty is compiled during `npm install`).

```sh
sudo apt update
sudo apt install -y git curl build-essential python3 openssh-client
```

Node.js: if `node -v` is older than 22.9 (or missing), install a current one. Prefer the user's own tool if they have one (nvm, fnm, asdf). Otherwise use NodeSource's 22.x repository, and tell the user you are adding it:

```sh
curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh && sudo bash /tmp/nodesource_setup.sh
sudo apt install -y nodejs
node -v      # must print v22.9 or later
```

Optional features, each one only needs its own packages. Install the ones the user wants; with no preference, install all of them, since the page simply hides what is missing:

| Feature | Packages (Debian/Ubuntu) |
| --- | --- |
| SSH connections with `.ppk` (PuTTY) keys | `putty-tools` |
| Thumbnails of images and videos, and the desktop's **Fluid** mode | `ffmpeg` |
| **Desktop** (remote desktop in the page) | `tigervnc-standalone-server tigervnc-common tigervnc-tools xfce4 dbus-x11` |
| Explorer "Trash" | `libglib2.0-bin` (usually already installed) |

```sh
sudo apt install -y putty-tools ffmpeg tigervnc-standalone-server tigervnc-common tigervnc-tools xfce4 dbus-x11
```

On other distributions use the equivalent packages (the README has the same table).

## 3. Get the code and install it

```sh
git clone https://github.com/cnmoro/AgentWarehouse.git ~/AgentWarehouse
cd ~/AgentWarehouse
npm install
```

If `npm install` fails while building `node-pty`, a package from step 2 is missing (`make`, `g++`, `python3`). Install it and run `npm install` again.

## 4. Configure

Settings come from a `.env` file in the project folder (git-ignored). Nothing has to be set for the default mode, so create the file only when you need it.

- Local-only mode (no Tailscale):

  ```sh
  printf 'HOST=127.0.0.1\n' >> .env
  ```

- Another port, because 7681 is taken: add `PORT=<number>`.
- Reaching the page by a name that is not the machine's own (a reverse proxy, a custom domain): add `ALLOWED_HOSTS=name.example.com`. Other host names get a `421` error on purpose.

`.env.example` lists every option with its default.

## 5. Create the login

The login is an email (or any user name) and a password of at least 12 characters, not containing the part of the email before the `@`.

1. Ask the user which email or user name they want. If they do not care, use their `git config user.email`, or `admin`.
2. Generate a strong password and keep it in a shell variable only:

   ```sh
   PW="$(head -c 18 /dev/urandom | base64 | tr -d '/+=' | cut -c1-20)"
   ```

3. Create the user by piping the answers in (the script reads the email and the password from stdin when it is not a terminal; `printf` is a shell builtin, so the password does not show up in `ps`):

   ```sh
   printf '%s\n%s\n' "$EMAIL" "$PW" | npm run set-user
   ```

   It prints `Saved <email>.` and writes `data/users.json` (only a hash of the password, never the password).

If the user prefers to choose the password themselves, tell them to run `npm run set-user` in this folder instead and wait.

## 6. Run it as a service

A systemd user service keeps it running and starts it at boot. The unit file in the repository has the author's folder in it, so write a copy with the real folder and the real `node`:

```sh
mkdir -p ~/.config/systemd/user
sed -e "s#^WorkingDirectory=.*#WorkingDirectory=$HOME/AgentWarehouse#" \
    -e "s#^ExecStart=/usr/bin/node#ExecStart=$(command -v node)#" \
    deploy/web-terminal.service > ~/.config/systemd/user/web-terminal.service
systemctl --user daemon-reload
systemctl --user enable --now web-terminal
loginctl enable-linger "$USER"      # keep it running when nobody is logged in; if it asks for permission, use sudo
```

(If another user service already uses the name `web-terminal`, pick a different name for the copy, for example `agent-warehouse.service`, and use that name below.)

### Check that it works

```sh
systemctl --user is-active web-terminal            # active
journalctl --user -u web-terminal -n 5 --no-pager  # "Web terminal listening on http://..."
```

The log line shows the address. Request the login page from that address (replace `ADDRESS`):

```sh
curl -s -o /dev/null -w '%{http_code}\n' http://ADDRESS/login      # 200
curl -s -o /dev/null -w '%{http_code}\n' http://ADDRESS/           # 302 (to the login page)
```

- Service ends right away with status `78`: there is no user yet (step 5) or a setting is wrong. The log says which.
- "Tailscale is not up": start Tailscale, or set `HOST=127.0.0.1` in `.env` and restart.
- `421`: you used a host name the server does not know. Use the address from the log, or add the name to `ALLOWED_HOSTS`.

Do not test the login with `curl` and the real password on the command line.

## 7. The desktop (optional)

The **Desktop** button shows a VNC server running as the same user. This app only relays to it, so one has to exist. Skip this step when the user does not want the desktop, or when `ss -ltn` showed a VNC server on port 5901 already (the app finds a running `Xvnc` on its own; use that one).

```sh
mkdir -p ~/.vnc
VNCPW="$(head -c 18 /dev/urandom | base64 | tr -d '/+=' | cut -c1-8)"      # a VNC password is at most 8 characters
printf '%s\n' "$VNCPW" | vncpasswd -f > ~/.vnc/passwd && chmod 600 ~/.vnc/passwd
cat > ~/.vnc/xstartup <<'EOT'
#!/bin/sh
unset SESSION_MANAGER
unset DBUS_SESSION_BUS_ADDRESS
[ -x /usr/bin/dbus-launch ] && eval `dbus-launch --sh-syntax --exit-with-session`
vncconfig -nowin &            # lets copy and paste work between the page and the desktop
exec startxfce4
EOT
chmod +x ~/.vnc/xstartup
```

The app reads `~/.vnc/passwd` and logs in by itself, so the user never types the VNC password. Do not show it.

Start the desktop as its own user service so that it survives a reboot. First check how this version of `vncserver` runs in the foreground (`vncserver -help` or `man vncserver`; the flag is `-fg` in TigerVNC 1.10 to 1.13):

```sh
cat > ~/.config/systemd/user/vnc-desktop.service <<'EOT'
[Unit]
Description=VNC desktop :1 (for Agent Warehouse)

[Service]
ExecStart=/usr/bin/vncserver :1 -localhost yes -geometry 1920x1080 -fg
ExecStop=/usr/bin/vncserver -kill :1
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOT
systemctl --user daemon-reload && systemctl --user enable --now vnc-desktop
```

`-localhost yes` keeps the VNC port closed to the network: the only way in is through the page and its login. If `vncserver -fg` does not exist in the installed version, run `vncserver :1 -localhost yes -geometry 1920x1080` once and tell the user it will not come back by itself after a reboot.

Check: `ss -ltn | grep 5901` shows a listener on 127.0.0.1, and `pgrep -a Xvnc` shows the server. **Do not connect to port 5901 yourself to test it** (not with `nc`, `vncviewer`, a script or anything else): TigerVNC blocks an address for several minutes after a few connections that close before logging in. The page does the test when the user opens Desktop.

The **Fluid** desktop mode (video, up to 60 fps) needs `ffmpeg` (step 2). Browsers only allow its fastest decoder (WebCodecs) on HTTPS or `localhost`; over plain HTTP it still works through a slightly slower path. HTTPS is step 8.

## 8. HTTPS with Tailscale (optional, recommended)

HTTPS makes the browser treat the page as a secure context: faster desktop video, the async clipboard, and a `Secure` session cookie. Skip it in local-only mode.

1. Look at what is already published, and never replace it:

   ```sh
   tailscale serve status
   ```

2. If it is empty, or if you can use a port that is free in that list (for example `8443`), add the app. Ask the user first, because this changes their tailnet setup. HTTPS certificates must be enabled for the tailnet (admin console → DNS → HTTPS Certificates); if the command says they are not, tell the user.

   ```sh
   printf 'TRUST_PROXY=1\n' >> .env          # the app now binds to 127.0.0.1 and trusts the proxy
   systemctl --user restart web-terminal
   tailscale serve --bg --https=8443 http://127.0.0.1:7681
   ```

   The page is then at `https://<machine>.<tailnet>.ts.net:8443`. Use `tailscale serve status` to read the exact name.

3. Never use `tailscale funnel`: it publishes the page on the public internet.

## Final report

Tell the user, in the language they used with you:

- **Where to open it:** the URL(s) (the Tailscale address from the log, or the `https://` one from step 8).
- **The login:** the email, and the generated password. Say that it is shown only now, that it is not stored anywhere in clear text, and how to change it later (`cd ~/AgentWarehouse && npm run set-user`).
- **What was installed:** the packages, the service names, the install folder, and which optional parts you set up or skipped (SSH key conversion, thumbnails, desktop, HTTPS).
- **What they should know:** restarting the service ends the programs running in their terminals (the screens come back, the programs do not), so restart it when nothing important is running. The browser shortcuts Ctrl+T, Ctrl+W and Ctrl+N cannot be captured by a web page, so the Desktop has a **Send key** menu and a full-screen button that passes them on.
- **Anything you could not do**, and exactly what is left for them.

## Updating

When it is already installed:

```sh
cd ~/AgentWarehouse
git status --short                      # local changes? stop and ask before pulling
git pull --ff-only
npm install
systemctl --user restart web-terminal   # ends the running programs in the terminals: ask first
```

Read the README's "After a server restart" section before restarting a copy that people are using.

## Removing it

Only when the user asks. Stop and disable the services (`systemctl --user disable --now web-terminal vnc-desktop`), delete the unit files in `~/.config/systemd/user/`, remove `tailscale serve` entries you added (`tailscale serve --https=8443 off`), and delete the project folder. The folder's `data/` holds the logins, saved SSH connections and terminal history, so confirm before deleting it.
