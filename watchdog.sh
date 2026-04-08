#!/bin/bash
# Portal Watchdog - auto-restart server.js + Star Office backend if they die
while true; do
  # --- Portal ---
  if ! curl -s -o /dev/null -w "" --max-time 3 "http://localhost:8080/health" 2>/dev/null; then
    echo "[$(date)] Portal down, restarting..."
    cd /home/node/.openclaw/workspace/portal || exit 1
    nohup env PORT=8080 NODE_ENV=production node server.js > portal_stdout.log 2>&1 &
    sleep 5
  fi

  # --- Stock Server (port 3000) ---
  if ! curl -s -o /dev/null -w "" --max-time 3 "http://localhost:3000" 2>/dev/null; then
    echo "[$(date)] Stock server down, restarting..."
    cd /home/node/.openclaw/workspace/portal || exit 1
    nohup env PORT=3000 node stock-server.js > stocks_stdout.log 2>&1 &
    sleep 3
  fi

  # --- Star Office (backend on :19000) ---
  if ! curl -s -o /dev/null -w "" --max-time 3 "http://localhost:19000/health" 2>/dev/null; then
    echo "[$(date)] Star Office backend down, restarting..."
    cd /home/node/Star-Office-UI/backend || exit 1
    FLASK_SECRET_KEY="fox-fleet-secret-2026" ASSET_DRAWER_PASS="FoxFleet2026!" \
      nohup python3 app.py > /tmp/star-office.log 2>&1 &
    sleep 3
  fi

  sleep 30
done
