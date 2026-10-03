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

The sidebar lists sessions. Each session has one or more tabs, shown along the top of the terminal; each tab is its own shell.

| Action | How |
| --- | --- |
| New session | `+` in the sidebar. It opens in the current tab's folder. |
| New tab | `+` at the end of the tabs. It opens in the folder of the session's first tab. |
| Rename | Double-click a session or tab name, the ✎ button, or F2. Enter saves, Esc cancels. |
| Reorder | Drag sessions in the sidebar, or tabs along the top. |
| Close | ✕ or Delete; middle-click also closes a tab. Closing a session closes all its tabs. This kills the shells and anything running in them. |
| Move between tabs | Click. From the keyboard: **Ctrl+Shift+E** jumps to the tab list, then arrow keys and Enter; Esc goes back to the terminal. |
| Copy | Select with the mouse, then **Ctrl+C**. With nothing selected, Ctrl+C sends an interrupt as usual. **Ctrl+Shift+C** always copies. |
| Paste | **Ctrl+V** or **Ctrl+Shift+V**. Bracketed paste is used when the program supports it. |
| Font size | **Ctrl +**, **Ctrl −**, **Ctrl 0**, or A−/A+ in the sidebar footer |
| Full history | **Ctrl+Shift+H**, the ⏱ button on a tab, or the button that appears at the top of the scrollback |
| Hide sidebar | « in the sidebar header. It collapses to a narrow strip; ☰ brings it back. |

On a Mac, use Cmd instead of Ctrl for copy, paste, font size and Ctrl+Shift+E. Ctrl then always goes to the terminal.

Shortcuts match on the physical key, so they work with any keyboard layout. Because Ctrl+V pastes, programs never receive a literal Ctrl+V. In vim, use Ctrl+Q for visual-block mode.

The browser keeps some keys for itself, and they never reach the shell: Ctrl+T, Ctrl+N, Ctrl+Tab, Ctrl+PgUp/PgDn and Ctrl+Shift+T/N/W. Ctrl+W would close the page; you get a confirmation first, but it still does not delete a word. Use Alt+Backspace instead.

On a phone, a row of keys under the terminal gives Esc, Tab, Ctrl (tap it, then a letter), arrows, and a few symbols that are awkward on phone keyboards. Swipe up and down to scroll through the history.

The browser asks before you leave the page, so a stray Ctrl+W (delete word in bash) doesn't close it. The shells keep running either way.

A yellow dot on a tab means the text on its screen changed since you last looked; on a session, that one of its tabs did. Output that leaves the screen as it was (a program redrawing itself, a status message that disappears again) does not count. A grey dot means the shell exited. Press Enter in that tab to start a new one.

When two browsers show the same terminal, the one you used last sets its size, and the other follows it.

### Files

The folder button at the top of the sidebar (**Ctrl+Shift+F**, Cmd+Shift+F on a Mac) opens a file browser over the terminal, starting in your home folder.

- **Navigate:** double-click folders, click the path to type one (`~` works), Backspace for the parent folder, Alt+←/→ for back and forward. Type a few letters to jump to a name; the filter box narrows the list.
- **Places and pins:** Home, the folder of the terminal on screen, and the whole computer. Pin any folder or file with ☆ or the right-click menu; pins are saved on the server, per user.
- **Preview:** click a file. Text shows with line numbers (the first 1 MB), images are shown, and binary files offer a download.
- **Upload:** drop files or whole folders on the list (they go into the folder shown) or on a folder row, a pin or a path segment (they go there). The ⇪ buttons pick files or a folder. If something already exists you choose: replace, keep both, or skip.
- **Right-click:** download (folders as .zip), copy the path, open a terminal tab in that folder, pin, rename, and move to the Trash. Delete also moves to the Trash; in places without one (such as /tmp) it asks before deleting for good.

Everything runs as the server's user, so the file browser can reach exactly what that user's shell can.

### Long history

The terminal itself keeps the last 10,000 lines (`SCROLLBACK`). Everything older is moved to disk, up to 200,000 lines per tab by default (`HISTORY_LINES`), and loaded only when you look at it:

- Scroll to the top of a terminal and a button offers the older lines. **Ctrl+Shift+H** (or ⏱ on the tab) opens the full history of the tab at any time.
- The history view draws only the rows on screen and fetches the rest from the server as you scroll, so a million lines cost about as much as a hundred. Colours are kept.
- Search with the box at the top: Enter finds the next older match, Shift+Enter the next newer one; it wraps around at the ends. Searching a million lines takes a fraction of a second.
- Select and copy text as on any web page. Long lines that the terminal wrapped are copied as one line.
- Ctrl+L (erase the screen) moves the screen's content into the scrollback instead of destroying it, as most terminals do. `clear` erases the history too, as it erases the scrollback in any terminal. A terminal reset (`reset`, or binary output that happens to contain the reset code) keeps it and adds a marker line. The history survives a server restart (the programs that produced it do not). Closing a tab deletes its history.

History is stored in `data/history/<tab>/` (readable only by you). Each tab keeps at most `HISTORY_LINES` lines (default 200,000) and `HISTORY_MB` megabytes (default 64); the oldest lines are dropped beyond either limit. Plain text needs about 10–20 MB for 200,000 lines; heavily coloured output reaches the megabyte limit sooner. Set `HISTORY_LINES=0` to turn history off. If the disk fills up, history stops for that tab and the terminal carries on. Archiving costs some throughput during extreme output floods (about 25% at a full-speed `cat` of a log), none at normal use.

### After a server restart

The tabs come back with the same names, in the same folders, at the same size, still showing what they showed. Programs that were running do not survive a restart, but:

- What was on screen stays. The newest 2,000 lines of each tab are written back into it (scroll up to see them; older ones are in the history view, Ctrl+Shift+H), followed by a `── server restarted ──` line. A full-screen program (`claude`, vim, htop) draws on a separate screen that is normally lost when it ends: at shutdown, what it was showing is saved too, under a heading such as `── claude was showing this when the server stopped ──`.
- If a command was running in a tab (say `claude`), the tab shows a short note, and once the shell shows its prompt the command is typed there, exactly as you entered it. Press Enter to start it again, or Ctrl+U to clear it. Nothing runs by itself, and nothing is typed while your startup files are still running or asking questions. The command is also the newest history entry, so ↑ brings it back if you cleared it. A command you hid from history with a leading space is not offered.
- Each tab keeps its own bash command history, saved after every command, so ↑ recalls what you ran in that tab. A new tab starts with a copy of your normal `~/.bash_history`. Commands typed in the web terminal are not added to `~/.bash_history`.

The state is saved every 10 seconds and on shutdown, in `data/tabs.json` and `data/shells/`; what the tabs showed is in `data/history/`.

Terminals start without the `CLAUDECODE` / `CLAUDE_CODE_*` variables of a Claude Code session the server may have been started from: inherited, they would stop `claude` in the web terminal from saving its conversations (so `claude -r` would have nothing to resume).

When the server stops, it hangs up every program started in any tab (including jobs left behind by shells that have exited), waits up to 2 seconds, then kills whatever is left. Run as the systemd service, it also stops programs that detached into their own session (`setsid`, daemons, tmux servers), so a stop or restart takes about 2 seconds and nothing keeps running. Started by hand (`npm start`), such detached programs are left alone, as they would be when closing any terminal.

## Limits

The screen you get back after a reload or on a second device matches the live one cell for cell, with these exceptions:

- Scrollback is shortened when a snapshot would exceed 2 MB (heavily coloured history).
- Tab stops, underline styles (curly, double, coloured) and national character sets other than DEC line drawing are not restored.

Some terminal features are limited on purpose, because programs (or files you `cat`) could otherwise freeze or crash the server or the browser:

- OSC 8 hyperlinks are ignored. Plain URLs in the output are still clickable.
- Escape strings (titles, clipboard, sixel, etc.) over 64 KB and colour palette sequences over 16 KB are ignored.
- A character cell holds at most 6 UTF-16 code units (a letter with up to five accents). Emoji sequences can grow to 16 units with emoji parts (joiners, skin tones, tags), which covers family emoji and flags. Extra combining marks are dropped.
- Resizing a very wide terminal whose whole history is unusual text, or taking a snapshot of a very wide, heavily coloured screen, can pause the server for up to a second or two. This happens once per resize or attach.
- Megabytes of deliberately unusual glyphs (thousands of distinct mark stacks) can still pause the visible tab for about a second while the browser draws them. The server and other tabs are not affected.
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

In plain-HTTP mode, browsers send the session cookie to every service on the same address, whatever the port (cookies are not separated by port). Any other web server on this machine's Tailscale IP would receive it. If other people can run services on this machine, use the HTTPS setup with `tailscale serve`, which gives the terminal its own host name.

Manage users:

```sh
npm run set-user                                     # add a user or change a password
npm run set-user -- --remove someone@example.com     # remove a user
```

## Configuration

See `.env.example`: `PORT`, `HOST`, `ALLOWED_HOSTS`, `TRUST_PROXY`, `SESSION_TTL_HOURS`, `SESSION_IDLE_HOURS`, `SCROLLBACK`, `HISTORY_LINES`, `HISTORY_MB`.

## Layout

```
server.js            HTTP routes, login, WebSocket protocol
lib/auth.js          password hashing, sessions, login throttling
lib/terminals.js     pty + headless mirror per tab, persistence of tab list
lib/history.js       on-disk history beyond the scrollback
scripts/set-user.js  create, update, or remove logins
public/              login page and the app (plain JS, no build step)
data/                users.json, tabs.json, history/ (git-ignored)
```
