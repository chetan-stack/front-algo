#!/bin/bash
cd "$(dirname "$0")"
if [ -f .runpids ]; then
  kill $(cat .runpids) 2>/dev/null
  rm .runpids
  echo "stopped."
else
  echo "no .runpids found — nothing to stop (or it wasn't started with start.sh)"
fi

# Per-user trading dashboards started by start.sh aren't tracked in .runpids
# (they're per-port, not one fixed set) -- kill by port instead, same as
# server.py's _kill_port. Leaves strategy bots (storesupportzone/store_exit/
# stetergy*) alone -- those are opt-in trading loops, stopped individually
# via the admin panel, not by this script.
sqlite3 -separator '|' users.db "SELECT webview_port, crypto_port FROM users;" 2>/dev/null |
while IFS='|' read -r webview_port crypto_port; do
  for port in "$webview_port" "$crypto_port"; do
    [ -n "$port" ] && lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | xargs -r kill
  done
done
echo "stopped dashboards."
