# Web Terminal

Several shells on this machine, open in the browser. Each terminal is a tab in the left sidebar and you can name it. Login is by email and password.

- **Rendering:** [xterm.js](https://xtermjs.org/), the same terminal emulator VS Code uses. `clear`, colors, progress bars, and full-screen TUIs (`htop`, `vim`, `less`) all work.
- **Shells:** [node-pty](https://github.com/microsoft/node-pty) runs a real login shell for each tab.
- **Reconnects:** the server keeps a headless xterm.js copy of each screen. If you reload the page, lose the connection, or open a second device, you get the current screen and scrollback back. Programs keep running while no browser is connected.

## Setup

Needs Node.js 22 or later. The first install compiles node-pty, so you also need `make`, `g++` and `python3`.

```sh
npm install
npm run set-user        # prompts for email and password (min. 12 characters)
npm start
```

With no `HOST` set, the server binds only to this machine's Tailscale IPv4 address on port 7681, e.g. `http://100.x.y.z:7681`. Other networks can't reach it.

To run it as a service, see `deploy/web-terminal.service`.

### HTTPS with `tailscale serve` (recommended)

Tailscale already encrypts the traffic. HTTPS still helps in two ways: the browser treats the page as a secure context, so copying uses the async clipboard API, and the session cookie gets the `Secure` flag.

```sh
echo -e "TRUST_PROXY=1\nPORT=7681" > .env        # binds to 127.0.0.1
tailscale serve --bg --https=443 http://127.0.0.1:7681
```

Open `https://<machine>.<tailnet>.ts.net`. HTTPS certificates must be enabled for your tailnet (admin console → DNS → HTTPS Certificates).

## Using it

| Action | How |
| --- | --- |
| New terminal | `+` in the sidebar. It opens in the current tab's folder. |
| Rename | Double-click the name, or the ✎ button. Enter saves, Esc cancels. |
| Reorder | Drag tabs in the sidebar. |
| Close | ✕. This kills the shell and anything running in it. |
| Copy | Select with the mouse, then **Ctrl+C**. With nothing selected, Ctrl+C sends an interrupt as usual. **Ctrl+Shift+C** always copies. |
| Paste | **Ctrl+V** or **Ctrl+Shift+V**. Bracketed paste is used when the program supports it. |
| Font size | **Ctrl +**, **Ctrl −**, **Ctrl 0** |
| Hide sidebar | ☰ at the top right. |

Because Ctrl+V pastes, programs never receive a literal Ctrl+V. In vim, use Ctrl+Q for visual-block mode.

A yellow dot on a tab means it printed output since you last looked. A grey dot means the shell exited. Press Enter in that tab to start a new one.

When two browsers show the same terminal, the one you used last sets its size.

Tab names and working folders are saved to `data/tabs.json`. After a server restart the tabs come back with fresh shells. Running programs do not survive a restart.

## Security

This page gives full shell access as the user running the server. The defences:

- Binds to the Tailscale interface (or to localhost behind `tailscale serve`), never to `0.0.0.0` by default.
- Passwords are hashed with scrypt (N=2¹⁵, r=8) in `data/users.json` (mode 600). Unknown emails still get a full hash check, so response time does not show which accounts exist.
- Login throttling: 5 failed attempts per IP and 30 in total per 15 minutes.
- Sessions use a 256-bit random token in an `HttpOnly`, `SameSite=Strict` cookie. The server stores only its SHA-256 hash, in memory. Sessions end after 24 h idle or 7 days, on sign-out, or on server restart.
- The WebSocket handshake and the login/logout endpoints reject requests whose `Origin` does not match the host. This blocks cross-site WebSocket hijacking and CSRF.
- A strict Content-Security-Policy (no inline scripts, no third-party origins), `frame-ancestors 'none'`, and `no-store` caching.

Manage users:

```sh
npm run set-user                                     # add a user or change a password
npm run set-user -- --remove someone@example.com     # remove (restart to end their sessions)
```

## Configuration

See `.env.example`: `PORT`, `HOST`, `TRUST_PROXY`, `SESSION_TTL_HOURS`, `SESSION_IDLE_HOURS`, `SCROLLBACK`.

## Layout

```
server.js            HTTP routes, login, WebSocket protocol
lib/auth.js          password hashing, sessions, login throttling
lib/terminals.js     pty + headless mirror per tab, persistence of tab list
scripts/set-user.js  create, update, or remove logins
public/              login page and the app (plain JS, no build step)
data/                users.json, tabs.json (git-ignored)
```
