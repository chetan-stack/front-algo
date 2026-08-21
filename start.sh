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
echo "stop with: ./stop.sh"
