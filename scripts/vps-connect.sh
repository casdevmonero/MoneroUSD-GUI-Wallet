#!/bin/bash
# VPS Remote Access Helper Script
# Usage:
#   ./scripts/vps-connect.sh             - Connect via SSH
#   ./scripts/vps-connect.sh upload      - Upload wallet files to VPS
#   ./scripts/vps-connect.sh download    - Download files from VPS
#   ./scripts/vps-connect.sh status      - Check VPS connection

VPS_HOST="vps"          # Matches ~/.ssh/config Host alias
VPS_USER="root"
VPS_PATH="/root/MoneroUSD-GUI-Wallet"

ACTION="${1:-connect}"

check_connection() {
    echo "Testing connection to VPS..."
    if ssh -o ConnectTimeout=10 "$VPS_HOST" "echo 'Connected successfully'" 2>/dev/null; then
        return 0
    else
        echo "ERROR: Could not connect to VPS. Check your SSH config and password."
        return 1
    fi
}

case "$ACTION" in
    connect)
        echo "Connecting to VPS as root..."
        ssh "$VPS_HOST"
        ;;
    upload)
        echo "Uploading project files to VPS at $VPS_PATH ..."
        ssh "$VPS_HOST" "mkdir -p $VPS_PATH"
        rsync -avz --exclude 'node_modules' --exclude '.git' \
            ./ "$VPS_HOST:$VPS_PATH/"
        echo "Upload complete."
        ;;
    download)
        echo "Downloading files from VPS $VPS_PATH ..."
        rsync -avz "$VPS_HOST:$VPS_PATH/" ./vps-backup/
        echo "Download complete to ./vps-backup/"
        ;;
    status)
        check_connection
        if [ $? -eq 0 ]; then
            echo ""
            echo "VPS System Info:"
            ssh "$VPS_HOST" "uname -a && df -h / && free -h"
        fi
        ;;
    *)
        echo "Unknown action: $ACTION"
        echo "Usage: $0 [connect|upload|download|status]"
        exit 1
        ;;
esac
