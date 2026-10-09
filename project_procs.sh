# Sourced by start.sh and stop.sh (run from the project folder).
#
# Backends and analysts are started as "python server.py" / "python analyst.py",
# with a RELATIVE path, so `pkill -f "$(pwd)/server.py"` never matched them and
# every restart left the old backend behind (6 orphans piled up Oct 5-9). Find
# them by their working folder instead: this project's copies only, never
# another project's server.py.
project_pids() {  # $1 = script name, e.g. server.py
  for pid in $(pgrep -f "$1"); do
    [ "$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')" = "$PWD" ] && echo "$pid"
  done
}

# SIGTERM first; the backend often survives it (its AngelOne tick thread keeps the
# process alive after the port is closed), so SIGKILL whatever is left after 5s.
stop_pids() {
  local pids="$*"
  [ -z "$pids" ] && return
  kill $pids 2>/dev/null
  for _ in 1 2 3 4 5; do
    sleep 1
    pids=$(for p in $pids; do kill -0 "$p" 2>/dev/null && echo "$p"; done)
    [ -z "$pids" ] && return
  done
  kill -9 $pids 2>/dev/null
}
