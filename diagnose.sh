#!/bin/bash
# Zeabur Portal Diagnostics Script

echo "=== Zeabur Portal Diagnostics ==="
echo ""

echo "1. Environment Variables:"
echo -e "\nPORT: ${PORT:-NOT_SET}"
echo "NODE_ENV: ${NODE_ENV:-NOT_SET}"
echo ""

echo "2. Port Binding Check:"
ss -tlnp 2>/dev/null | grep -E ":(3000|8080|PORT)" || lsof -i -P -n 2>/dev/null | grep -E ":(3000|8080)" || echo "No listening ports found"
echo ""

echo "3. Process Status:"
ps aux | grep -E "(node server|twai-portal)" | grep -v grep || echo "No portal process running"
echo ""

echo "4. Startup Log Simulation:"
cd /home/node/.openclaw/workspace/portal 2>/dev/null || echo "Cannot find portal directory"
if [ -f "zeabur_test.log" ]; then
    tail -10 zeabur_test.log
else
    echo "No zeabur_test.log found"
fi
echo ""

echo "5. Direct Test: http://localhost:${PORT:-3000}"
curl -sS -o /dev/null -w "HTTP %{http_code}\n" http://localhost:${PORT:-3000}/ || echo "Connection failed"
echo ""

echo "=== Diagnostics Complete ==="