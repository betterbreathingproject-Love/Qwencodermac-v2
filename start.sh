#!/bin/bash
# MLX Vision Server launcher
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Starting MLX Vision Server..."
cd "$SCRIPT_DIR"

# open the UI in browser
sleep 1 && open "$SCRIPT_DIR/ui.html" &

# start the server
python3 server.py "$@"
