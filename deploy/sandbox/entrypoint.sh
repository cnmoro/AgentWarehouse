#!/bin/sh
# The home folder is mounted from the host and starts empty: give it the usual dotfiles once.
for f in .bashrc .profile .bash_logout; do
  [ -e "$HOME/$f" ] || cp "/etc/skel/$f" "$HOME/$f" 2>/dev/null
done
exec node /app/server.js
