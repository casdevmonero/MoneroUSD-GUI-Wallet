# MoneroUSD (USDm) Desktop Wallet

Private stablecoin wallet for **MoneroUSD (USDm)**. Available as a desktop app (Electron) and a browser-based web wallet.

**Website:** [monerousd.org](https://monerousd.org)

## Features

- **Dashboard** — USDm balance with real-time sync
- **Send / Receive** — Send USDm to any address, receive with QR codes
- **Swap** — Atomic swaps between BTC, XMR, and USDm via the swap backend
- **Staking** — Lock USDm to earn yield (flexible, 30/90/180 day tiers)
- **Lending** — Deposit BTC or XMR as collateral to borrow USDm
- **History** — Full transaction history with filters
- **Import** — Restore a wallet from a 25-word seed phrase (seed is never stored or logged)
- **Local Node** — Run your own USDmd full node directly from the wallet
- **Mining** — CPU mining with adjustable threads
- **Auto-Updates** — OTA updates delivered automatically

## Download

Pre-built binaries for all platforms are available at [monerousd.org](https://monerousd.org):

- **Windows** — `.exe` installer
- **macOS** — `.zip` (x64 and Apple Silicon)
- **Linux** — `.AppImage` and `.deb`

## Run from source

### Desktop app (Electron)

```bash
npm install
npm start
```

### Browser mode (web wallet)

```bash
npm install
npm run browser
```

Then open **http://localhost:3000** in your browser.

## Build distributable

```bash
npm run build          # Linux + Windows
npm run build:mac      # macOS
npm run build:all      # All platforms
```

Output is in `dist/`.

## Architecture

The wallet connects to the **MoneroUSD relay network** by default — no local node required. For full sovereignty, you can run your own USDmd node and wallet-rpc, then switch to a custom node in Settings.

### Desktop (Electron)

- `main.js` — Electron main process: window management, local node/wallet-rpc management, RPC proxy, auto-updater
- `preload.js` — Context bridge exposing IPC to the renderer
- `renderer/` — Frontend (HTML/CSS/JS): wallet UI, onboarding, swap modal, staking, lending

### Browser

- `server.js` — Node.js HTTP server: serves the UI, proxies wallet RPC, manages per-user sessions
- `app.js` — Browser-specific frontend logic
- `index.html` / `styles.css` — Browser UI

## Configuration

All configuration is done through the **Settings** page in the app:

| Setting | Description |
|---------|-------------|
| Daemon URL | Your USDmd node (only needed if using a custom node) |
| Wallet RPC URL | Your wallet-rpc instance (only needed if using a custom node) |
| Swap Backend URL | Swap service endpoint (default: `https://swap.monerousd.org`) |
| Light Wallet URL | Optional light wallet server |

Environment variables for `server.js` (browser mode):

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP server port |
| `DAEMON_RPC_URL` | `http://localhost:17750` | Daemon RPC endpoint |
| `WALLET_RPC_BIN` | `USDm-wallet-rpc` | Path to wallet-rpc binary |
| `MINER_ADDRESS` | _(empty)_ | Address for auto-mining rewards |

## Running your own node

1. Build USDmd from the [MoneroUSD source](https://github.com/casdevmonero/MoneroUSD)
2. Place the `USDmd` and `USDm-wallet-rpc` binaries in `~/.monerousd/bin/`
3. In the wallet app, go to **Settings → Run Local Node → Create Node & Start Syncing**

Or start manually:

```bash
./USDmd --data-dir ~/.monerousd/blockchain --rpc-bind-port 17750 --add-peer seed.monerousd.org:17749
```

## License

MIT
