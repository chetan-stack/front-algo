#!/bin/bash
# Starts frontend, backend, and their cloudflare tunnels. Logs to logs/*.log, PIDs to .runpids
cd "$(dirname "$0")"
mkdir -p logs

# kill any previous run so the backend port is free before we bind it again
if [ -f .runpids ]; then
  kill $(cat .runpids) 2>/dev/null
  sleep 1
fi

nohup npm run dev >logs/frontend.log 2>&1 &
FRONTEND_PID=$!

nohup env SSL_CERT_FILE=$(.venv/bin/python -m certifi) .venv/bin/python server.py >logs/backend.log 2>&1 &
BACKEND_PID=$!

sleep 2 # let dev servers claim their ports before tunneling them

nohup cloudflared tunnel --url http://localhost:5173 >logs/tunnel-frontend.log 2>&1 &
TUNNEL_FRONTEND_PID=$!

nohup cloudflared tunnel --url http://localhost:4001 >logs/tunnel-backend.log 2>&1 &
TUNNEL_BACKEND_PID=$!

echo "$FRONTEND_PID $BACKEND_PID $TUNNEL_FRONTEND_PID $TUNNEL_BACKEND_PID" >.runpids

# wait for the backend's quick-tunnel URL and patch it into Chart.jsx (it's random every run)
BACKEND_URL=""
for i in $(seq 1 30); do
  BACKEND_URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' logs/tunnel-backend.log | head -1)
  [ -n "$BACKEND_URL" ] && break
  sleep 1
done

if [ -n "$BACKEND_URL" ]; then
  sed -i '' "s|^export const API = '.*'|export const API = '$BACKEND_URL'|" src/api.js
  echo "patched src/api.js API -> $BACKEND_URL"
else
  echo "WARNING: backend tunnel URL didn't show up in time, src/api.js not patched"
fi

FRONTEND_URL=""
for i in $(seq 1 30); do
  FRONTEND_URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' logs/tunnel-frontend.log | head -1)
  [ -n "$FRONTEND_URL" ] && break
  sleep 1
done
echo "frontend: $FRONTEND_URL"
echo "backend:  $BACKEND_URL"

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
sqlite3 -separator '|' users.db "SELECT username, webview_port, crypto_port, is_admin FROM users;" |
while IFS='|' read -r username webview_port crypto_port is_admin; do
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

  if [ -n "$crypto_port" ] && ! lsof -tiTCP:"$crypto_port" -sTCP:LISTEN >/dev/null 2>&1; then
    log_name=$(basename "$crypto_account_dir")
    (cd "$crypto_account_dir" && PORT="$crypto_port" nohup "$SMARTAPI_VENV_PYTHON" "$SMARTAPI_DIR/crypto/webviewdataapi.py" \
      >"$SMARTAPI_DIR/logs/${log_name}_webviewdataapi.log" 2>&1 &)
    sleep 1.5  # DeltaEx has no login/rate-limit step, unlike AngelOne -- no need to stagger
  fi
done

echo "stop with: ./stop.sh"
