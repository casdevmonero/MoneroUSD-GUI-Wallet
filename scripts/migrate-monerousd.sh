#!/bin/bash
# Migrate MoneroUSD folder from rescue-mode VPS to destination VPS
# Run this FROM YOUR LOCAL MACHINE
#
# Usage: bash scripts/migrate-monerousd.sh
#
# Requirements: sshpass (apt install sshpass / brew install sshpass)

SOURCE_IP="148.163.122.39"
SOURCE_USER="root"
SOURCE_PASS=''  # Set your rescue mode password here

DEST_IP="72.61.4.19"
DEST_USER="root"
DEST_PASS='Raven825@0583'

SSH_OPTS="-o StrictHostKeyChecking=no -o ConnectTimeout=15"

echo "=== MoneroUSD Migration Script ==="
echo "Source: ${SOURCE_USER}@${SOURCE_IP} (rescue mode)"
echo "Dest:   ${DEST_USER}@${DEST_IP}"
echo ""

# Check source password is set
if [ -z "$SOURCE_PASS" ]; then
    echo "ERROR: Set SOURCE_PASS in this script (your rescue mode root password)"
    exit 1
fi

# Step 1: Find the MoneroUSD folder on the source
echo "[1/3] Locating MoneroUSD folder on source VPS..."
MONEROUSD_PATH=$(sshpass -p "$SOURCE_PASS" ssh $SSH_OPTS ${SOURCE_USER}@${SOURCE_IP} \
    "find / -maxdepth 6 -type d -name 'monerousd' -o -type d -name 'MoneroUSD' -o -type d -name '.bitmonero' 2>/dev/null | head -5")

if [ -z "$MONEROUSD_PATH" ]; then
    echo "Auto-detect failed. Trying common paths..."
    for path in /root/monerousd /root/MoneroUSD /root/.bitmonero /home/monerousd /opt/monerousd; do
        EXISTS=$(sshpass -p "$SOURCE_PASS" ssh $SSH_OPTS ${SOURCE_USER}@${SOURCE_IP} "[ -d '$path' ] && echo yes || echo no")
        if [ "$EXISTS" = "yes" ]; then
            MONEROUSD_PATH="$path"
            break
        fi
    done
fi

if [ -z "$MONEROUSD_PATH" ]; then
    echo "ERROR: Could not find MoneroUSD folder. Check source VPS manually."
    exit 1
fi

echo "Found: $MONEROUSD_PATH"

# Step 2: Get folder size
echo "[2/3] Checking folder size..."
sshpass -p "$SOURCE_PASS" ssh $SSH_OPTS ${SOURCE_USER}@${SOURCE_IP} "du -sh '$MONEROUSD_PATH'"

# Step 3: Stream the folder directly from source to destination
echo "[3/3] Transferring MoneroUSD folder to ${DEST_IP}..."
echo "This may take a while depending on folder size..."

sshpass -p "$SOURCE_PASS" ssh $SSH_OPTS ${SOURCE_USER}@${SOURCE_IP} \
    "tar czf - '$MONEROUSD_PATH'" | \
    sshpass -p "$DEST_PASS" ssh $SSH_OPTS ${DEST_USER}@${DEST_IP} \
    "cd /root && tar xzf - && echo 'Transfer complete'"

if [ $? -eq 0 ]; then
    echo ""
    echo "=== Migration Complete ==="
    echo "MoneroUSD folder transferred to ${DEST_IP}:/root/"
    echo ""
    echo "Verify on destination:"
    echo "  ssh root@${DEST_IP}"
    echo "  ls -la /root/$(basename $MONEROUSD_PATH)"
else
    echo ""
    echo "ERROR: Transfer failed. Check connectivity and credentials."
    echo "You can also try rsync directly:"
    echo "  sshpass -p '\$SOURCE_PASS' rsync -avz -e 'sshpass -p \$SOURCE_PASS ssh $SSH_OPTS' \\"
    echo "    ${SOURCE_USER}@${SOURCE_IP}:${MONEROUSD_PATH}/ \\"
    echo "    ${DEST_USER}@${DEST_IP}:/root/monerousd/"
    exit 1
fi
