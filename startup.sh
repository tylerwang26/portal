#!/bin/bash
# Zeabur startup script - Ensures correct port binding
set -e

echo "Starting Zeabur Portal..."

# Create logs directory if needed
mkdir -p logs

# Set environment variables explicitly
export PORT=${PORT:-3000}
export NODE_ENV=${NODE_ENV:-production}

echo "Using PORT: $PORT"
echo "Using NODE_ENV: $NODE_ENV"

# Change to portal directory
cd /home/node/wspace/port 2>/dev/null || cd /home/node/.openclaw/workspace/portal || true

# Start the server
echo "Starting node server..."
exec node server.js