# Web Terminal

Several shells on this machine, open in the browser. Each terminal is a tab in the left sidebar and you can name it. Login is by email and password.

- **Rendering:** [xterm.js](https://xtermjs.org/), the same terminal emulator VS Code uses. `clear`, colors, progress bars, and full-screen TUIs (`htop`, `vim`, `less`) all work.
- **Shells:** [node-pty](https://github.com/microsoft/node-pty) runs a real login shell for each tab.
- **Reconnects:** the server keeps a headless xterm.js copy of each screen. If you reload the page, lose the connection, or open a second device, you get the current screen and scrollback back, including terminal modes such as mouse reporting and the scroll region. Programs keep running while no browser is connected.
- **Flow control:** the browser acknowledges output as it renders it, and the server pauses the program when the browser falls behind. Ctrl+C during a flood of ordinary output (`yes`, a big `cat`) takes effect in well under a second; floods of deliberately expensive escape sequences can take a few seconds on a very large screen. A browser that stops reading for 5 seconds (a sleeping laptop, say) no longer holds the program back; it gets a fresh copy of the screen when it wakes up.

## Setup

Needs Node.js 22.9 or later. The first install compiles node-pty, so you also need `make`, `g++` and `python3`.

```sh
npm install
npm run set-user        # prompts for email and password (min. 12 characters)
npm start
```

With no `HOST` set, the server binds only to this machine's Tailscale IPv4 address on port 7681, e.g. `http://100.x.y.z:7681`. Other networks can't reach it. If Tailscale is not up yet, the server exits and systemd retries.

Requests must use one of this machine's own names: its Tailscale IPs, its MagicDNS name, its hostname or localhost. Other host names get a 421 error, which blocks DNS-rebinding attacks from web pages. Add extra names to `ALLOWED_HOSTS` (comma-separated) if you need them.

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
| Rename | Double-click the name, the ✎ button, or F2. Enter saves, Esc cancels. |
| Reorder | Drag tabs in the sidebar. |
| Close | ✕ or Delete. This kills the shell and anything running in it. |
| Move between tabs | Click. From the keyboard: **Ctrl+Shift+E** jumps to the tab list, then arrow keys and Enter; Esc goes back to the terminal. |
| Copy | Select with the mouse, then **Ctrl+C**. With nothing selected, Ctrl+C sends an interrupt as usual. **Ctrl+Shift+C** always copies. |
| Paste | **Ctrl+V** or **Ctrl+Shift+V**. Bracketed paste is used when the program supports it. |
| Font size | **Ctrl +**, **Ctrl −**, **Ctrl 0**, or A−/A+ in the sidebar footer |
| Hide sidebar | « in the sidebar header. It collapses to a narrow strip; ☰ brings it back. |

On a Mac, use Cmd instead of Ctrl for copy, paste, font size and Ctrl+Shift+E. Ctrl then always goes to the terminal.

Shortcuts match on the physical key, so they work with any keyboard layout. Because Ctrl+V pastes, programs never receive a literal Ctrl+V. In vim, use Ctrl+Q for visual-block mode.

The browser keeps some keys for itself, and they never reach the shell: Ctrl+T, Ctrl+N, Ctrl+Tab, Ctrl+PgUp/PgDn and Ctrl+Shift+T/N/W. Ctrl+W would close the page; you get a confirmation first, but it still does not delete a word. Use Alt+Backspace instead.

On a phone, a row of keys under the terminal gives Esc, Tab, Ctrl (tap it, then a letter), arrows, and a few symbols that are awkward on phone keyboards. Swipe up and down to scroll through the history.

The browser asks before you leave the page, so a stray Ctrl+W (delete word in bash) doesn't close it. The shells keep running either way.

A yellow dot on a tab means it printed output since you last looked. A grey dot means the shell exited. Press Enter in that tab to start a new one.

When two browsers show the same terminal, the one you used last sets its size, and the other follows it.

Tab names and working folders are saved to `data/tabs.json`. After a server restart the tabs come back with fresh shells. Running programs do not survive a restart.

## Limits

The screen you get back after a reload or on a second device matches the live one cell for cell, with these exceptions:

- Scrollback is shortened when a snapshot would exceed 2 MB (heavily coloured history).
- Tab stops, underline styles (curly, double, coloured) and national character sets other than DEC line drawing are not restored.

Some terminal features are limited on purpose, because programs (or files you `cat`) could otherwise freeze or crash the server or the browser:

- OSC 8 hyperlinks are ignored. Plain URLs in the output are still clickable.
- Escape strings (titles, clipboard, sixel, etc.) over 64 KB and colour palette sequences over 16 KB are ignored.
- A character cell holds at most 6 UTF-16 code units (a letter with up to five accents), or 16 for emoji sequences (enough for family emoji and flags). Extra combining marks are dropped.
- Huge repeat counts in scroll, insert/delete-line, tab and repeat-character sequences are cut to the screen size.
- In the browser, colour changes and cursor-blink changes are rate-limited during floods.
- Answers to terminal queries (cursor position, colours, etc.) are dropped while more than about a thousand are waiting for a program that isn't reading them.

## Security

This page gives full shell access as the user running the server. The defences:

- Binds to the Tailscale interface (or to localhost behind `tailscale serve`), never to `0.0.0.0` by default.
- Accepts only this machine's own host names (see above), so a web page can't use DNS rebinding to reach the server.
- Passwords are hashed with scrypt (N=2¹⁵, r=8) in `data/users.json` (mode 600). Unknown emails still get a full hash check, so response time does not show which accounts exist.
- Login throttling: 5 attempts per IP per 15 minutes, counted before the password is checked, so parallel requests can't get around it. At most 4 password checks run at once. There is no global lockout, so failed attempts from elsewhere can't lock you out.
- Sessions use a 256-bit random token in an `HttpOnly`, `SameSite=Strict` cookie. The server stores only its SHA-256 hash, in memory. Sessions end after 24 h idle or 7 days, on sign-out, on server restart, or within 10 seconds of the user's password being changed or the user being removed.
- Links from terminal output only open if they are `http` or `https`.
- The WebSocket handshake and the login/logout endpoints reject requests whose `Origin` does not match the host. This blocks cross-site WebSocket hijacking and CSRF.
- A strict Content-Security-Policy (no inline scripts, no third-party origins), `frame-ancestors 'none'`, and `no-store` caching.

Manage users:

```sh
npm run set-user                                     # add a user or change a password
npm run set-user -- --remove someone@example.com     # remove a user
```

## Configuration

See `.env.example`: `PORT`, `HOST`, `ALLOWED_HOSTS`, `TRUST_PROXY`, `SESSION_TTL_HOURS`, `SESSION_IDLE_HOURS`, `SCROLLBACK`.

## Layout

```
server.js            HTTP routes, login, WebSocket protocol
lib/auth.js          password hashing, sessions, login throttling
lib/terminals.js     pty + headless mirror per tab, persistence of tab list
scripts/set-user.js  create, update, or remove logins
public/              login page and the app (plain JS, no build step)
data/                users.json, tabs.json (git-ignored)
```
