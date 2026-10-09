#!/bin/bash
cd "$(dirname "$0")"
. ./project_procs.sh
# frontend + tunnel (and the backend) from start.sh's last run
if [ -f .runpids ]; then
  kill $(cat .runpids) 2>/dev/null
  rm .runpids
fi
# every backend and analyst of this project, including orphans .runpids forgot
stop_pids $(project_pids server.py) $(project_pids analyst.py)

# Per-user trading dashboards started by start.sh aren't tracked in .runpids
# (they're per-port, not one fixed set) -- kill by port instead, same as
# server.py's _kill_port. Leaves strategy bots (storesupportzone/store_exit/
# stetergy*) alone -- those are opt-in trading loops, stopped individually
# via the admin panel, not by this script.
sqlite3 -separator '|' users.db "SELECT webview_port, ai_port, crypto_port FROM users;" 2>/dev/null |
while IFS='|' read -r webview_port ai_port crypto_port; do
  for port in "$webview_port" "$ai_port" "$crypto_port"; do
    [ -n "$port" ] && lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | xargs -r kill
  done
done
echo "stopped dashboards."

left="$(project_pids server.py) $(project_pids analyst.py)"
if [ -n "${left// /}" ]; then
  echo "STILL RUNNING (pids): $left"
else
  echo "stopped: backend, analysts, frontend, tunnel, dashboards. (Strategy/exit bots: Admin panel.)"
fi
