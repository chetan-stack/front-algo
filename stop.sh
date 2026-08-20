#!/bin/bash
cd "$(dirname "$0")"
if [ -f .runpids ]; then
  kill $(cat .runpids) 2>/dev/null
  rm .runpids
  echo "stopped."
else
  echo "no .runpids found — nothing to stop (or it wasn't started with start.sh)"
fi
