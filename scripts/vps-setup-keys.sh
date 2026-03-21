#!/bin/bash
# Run this script FROM YOUR LOCAL MACHINE to install the SSH key on the VPS
# Usage: bash scripts/vps-setup-keys.sh
#
# Requirements: sshpass installed locally (apt install sshpass / brew install sshpass)

VPS_IP="148.163.122.39"
VPS_USER="root"
VPS_PASS='x)gWWt631[FF2h'
KEY_FILE="$HOME/.ssh/id_rsa_vps"

echo "=== VPS SSH Key Setup ==="

# Generate key if it doesn't exist locally
if [ ! -f "$KEY_FILE" ]; then
    echo "[1/3] Generating SSH key pair..."
    ssh-keygen -t rsa -b 4096 -f "$KEY_FILE" -N "" -C "MoneroUSD-GUI-Wallet VPS access"
else
    echo "[1/3] SSH key already exists at $KEY_FILE"
fi

# Install the public key on VPS
echo "[2/3] Installing public key on VPS $VPS_IP ..."
PUB_KEY=$(cat "${KEY_FILE}.pub")
sshpass -p "$VPS_PASS" ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 \
    "${VPS_USER}@${VPS_IP}" \
    "mkdir -p ~/.ssh && chmod 700 ~/.ssh && \
     echo '$PUB_KEY' >> ~/.ssh/authorized_keys && \
     sort -u ~/.ssh/authorized_keys -o ~/.ssh/authorized_keys && \
     chmod 600 ~/.ssh/authorized_keys && \
     echo 'Public key installed successfully.'"

if [ $? -ne 0 ]; then
    echo "ERROR: Could not connect to VPS. Check IP, password, and that port 22 is open."
    exit 1
fi

# Test passwordless login
echo "[3/3] Testing passwordless SSH login..."
ssh -i "$KEY_FILE" -o StrictHostKeyChecking=no -o PasswordAuthentication=no \
    -o ConnectTimeout=10 "${VPS_USER}@${VPS_IP}" "echo 'Passwordless login SUCCESS'"

if [ $? -eq 0 ]; then
    echo ""
    echo "=== Setup Complete ==="
    echo "You can now connect with: ssh -i $KEY_FILE root@$VPS_IP"
    echo "Or add to ~/.ssh/config:"
    echo ""
    echo "Host vps"
    echo "    HostName $VPS_IP"
    echo "    User root"
    echo "    IdentityFile $KEY_FILE"
    echo "    ServerAliveInterval 60"
else
    echo "Key install succeeded but passwordless test failed. Try manually: ssh -i $KEY_FILE root@$VPS_IP"
fi
