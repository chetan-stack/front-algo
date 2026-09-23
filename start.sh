#!/bin/bash
# Starts frontend, backend, and their cloudflare tunnels. Logs to logs/*.log, PIDs to .runpids
cd "$(dirname "$0")"
mkdir -p logs

# kill any previous run so the backend port is free before we bind it again.
# .runpids only remembers the PIDs from THIS script's own last run — if a
# previous backend was ever started a different way (a new terminal, a
# reboot, a crash) and never went through stop.sh, it's invisible to that
# file and would sit there forever as dead weight. Confirmed live: 8 orphaned
# server.py copies piled up over more than a week this way, silently eating
# memory until free RAM hit ~15MB and requests started failing. Sweep by
# name too (scoped to this project's own path, not every server.py on the
# machine) so an orphan can't survive a restart just because .runpids forgot it.
pkill -f "$(pwd)/server.py" 2>/dev/null
pkill -f "$(pwd)/node_modules/.bin/vite" 2>/dev/null
sleep 1
# Confirmed live: a stuck orphan under memory pressure ignored plain SIGTERM
# entirely (sat there unchanged) and only -9 actually removed it — so don't
# assume the pkill above worked, force anything still standing.
pkill -9 -f "$(pwd)/server.py" 2>/dev/null
pkill -9 -f "$(pwd)/node_modules/.bin/vite" 2>/dev/null
if [ -f .runpids ]; then
  kill $(cat .runpids) 2>/dev/null
  # wait for the old frontend/backend to release their ports; otherwise vite silently drifts to 5174
  for i in $(seq 1 15); do
    lsof -tiTCP:5173,4001 -sTCP:LISTEN >/dev/null 2>&1 || break
    sleep 1
  done
fi

nohup npm run dev >logs/frontend.log 2>&1 &
FRONTEND_PID=$!

nohup env SSL_CERT_FILE=$(.venv/bin/python -m certifi) .venv/bin/python server.py >logs/backend.log 2>&1 &
BACKEND_PID=$!

sleep 2 # let dev servers claim their ports before tunneling them

# one named tunnel (config in ~/.cloudflared/config.yml): app.tradesmartai.in -> 5173, backend.tradesmartai.in -> 4001
nohup cloudflared tunnel run tradesmartai >logs/tunnel.log 2>&1 &
TUNNEL_PID=$!

echo "$FRONTEND_PID $BACKEND_PID $TUNNEL_PID" >.runpids
echo "frontend: https://app.tradesmartai.in"
echo "backend:  https://backend.tradesmartai.in"

# Per-user trading dashboards (webviewdataapi.py) aren't managed by the
# backend on boot -- it only (re)starts them as a side effect of the admin
# "add user"/"save credentials" flows -- so without this they stay down
# after every machine/app restart until someone manually re-saves creds.
# Read users.db directly (source of truth for ports) instead of
# hardcoding a user list here. Only a REAL account's india dashboard needs
# the 8s AngelOne-rate-limit stagger (an actual broker login); a demo
# account has no login step at all, so it gets a short flat sleep instead --
# flat 8s for everyone used to make a 7-user restart take 90+ seconds for
# no reason, almost all of it sleeping on accounts that were never going to
# hit a real rate limit in the first place.
SMARTAPI_DIR=~/PycharmProjects/pythonProject/SmartApi
SMARTAPI_VENV_PYTHON=~/PycharmProjects/pythonProject/venv/bin/python
mkdir -p "$SMARTAPI_DIR/logs"
sqlite3 -separator '|' users.db "SELECT username, webview_port, ai_port, crypto_port, is_admin FROM users;" |
while IFS='|' read -r username webview_port ai_port crypto_port is_admin; do
  if [ "$is_admin" = "1" ]; then
    account_dir="$SMARTAPI_DIR"
    crypto_account_dir="$SMARTAPI_DIR/crypto"
  else
    account_dir="$SMARTAPI_DIR/accounts/$username"
    crypto_account_dir="$SMARTAPI_DIR/crypto/accounts/$username"
  fi

  if ! lsof -tiTCP:"$webview_port" -sTCP:LISTEN >/dev/null 2>&1; then
    log_name=$(basename "$account_dir")
    (cd "$account_dir" && PORT="$webview_port" nohup "$SMARTAPI_VENV_PYTHON" "$SMARTAPI_DIR/webviewdataapi.py" \
      >"$SMARTAPI_DIR/logs/${log_name}_webviewdataapi.log" 2>&1 &)
    if grep -q "demo_mode = True" "$account_dir/document.py" 2>/dev/null; then
      sleep 1.5
    else
      sleep 8
    fi
  fi

  # ai_order_service.py (Buy CE/Buy PE and every other manual/AI order
  # button) has the exact same gap as webviewdataapi.py had -- never
  # started by the backend on boot, only as a side effect of admin
  # create-user/save-credentials. Confirmed it had been down for every
  # original user since Aug 30 (only Vaibhav's ran, from account creation).
  if ! lsof -tiTCP:"$ai_port" -sTCP:LISTEN >/dev/null 2>&1; then
    log_name=$(basename "$account_dir")
    (cd "$account_dir" && PORT="$ai_port" nohup "$SMARTAPI_VENV_PYTHON" "$SMARTAPI_DIR/ai_order_service.py" \
      >"$SMARTAPI_DIR/logs/${log_name}_ai_order_service.log" 2>&1 &)
    if grep -q "demo_mode = True" "$account_dir/document.py" 2>/dev/null; then
      sleep 1.5
    else
      sleep 3
    fi
  fi

  if [ -n "$crypto_port" ] && ! lsof -tiTCP:"$crypto_port" -sTCP:LISTEN >/dev/null 2>&1; then
    log_name=$(basename "$crypto_account_dir")
    (cd "$crypto_account_dir" && PORT="$crypto_port" nohup "$SMARTAPI_VENV_PYTHON" "$SMARTAPI_DIR/crypto/webviewdataapi.py" \
      >"$SMARTAPI_DIR/logs/${log_name}_webviewdataapi.log" 2>&1 &)
    sleep 1.5  # DeltaEx has no login/rate-limit step, unlike AngelOne -- no need to stagger
  fi
done

# Read-only market/account analysts (analyst.py): one process PER MARKET so each can be
# started/stopped on its own (app Alerts/Report tabs). They write reports + alerts to
# ~/tradingview-analysis/ every 3 min and never touch a bot or config. Only one copy of
# each is started; stop.sh leaves them alone (India sleeps outside market hours itself).
mkdir -p ~/tradingview-analysis
for market in india crypto; do
  # [Pp]: the venv interpreter shows as "Python" (capital P) in the process list, the system one as "python3"
  if ! pgrep -f "[Pp]ython[0-9.]* analyst\.py --market $market\$" >/dev/null; then
    nohup python3 analyst.py --market $market >~/tradingview-analysis/analyst_$market.out 2>&1 &
    echo "$market analyst started"
  else
    echo "$market analyst already running"
  fi
done

echo "stop with: ./stop.sh"
