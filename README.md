# Monero USD Desktop Wallet

Desktop frontend for the Monero USD (USDm) CLI wallet. Uses **Monero logo colors** (orange `#FF6600`, dark backgrounds) and connects to the **Monero USD wallet RPC** (haven-wallet-rpc binary from haven-main) for balance, send, receive, history, and swap info. USDm is based on Monero; the app configures the wallet RPC **like Monero**: it calls `set_daemon`, enables `auto_refresh` (periodic blockchain sync, 20s), and runs `refresh` on connect so balance updates correctly. The desktop app uses the same wallet RPC and wallet files as the CLI; when you open the same wallet in haven-wallet-rpc, the USDm balance and history shown in the app match the CLI (same `get_balance` / `get_transfers` and atomic units).

## Features

- **Dashboard** – USDm and XMR balances, quick actions
- **Send** – Send USDm to an address (calls wallet RPC `transfer`)
- **Receive** – Show primary address, copy to clipboard
- **Swap** – XMR↔USDm quotes and CLI instructions (swap executed via CLI)
- **History** – Transaction list from wallet RPC
- **Import** – Restore a wallet from your 25-word seed phrase (private; seed is never stored or logged)
- **Settings** – Wallet RPC URL (default `http://localhost:27750`)

## Prerequisites

1. Build the **Monero USD wallet RPC** (haven-wallet-rpc) from the `haven-main` repo.
2. Run the wallet RPC with your wallet, for example:
   ```bash
   ./haven-wallet-rpc --rpc-bind-port=27750 --wallet-file=mywallet --password=...
   ```
   To use **Import from seed**, start the RPC with a wallet directory (so it can create the restored wallet file):
   ```bash
   ./haven-wallet-rpc --rpc-bind-port=27750 --wallet-dir=/path/to/wallet/dir
   ```
   Then use the Import page to restore from your seed; the wallet is created in that directory and loaded.

### Haven daemon (required – no public nodes)

**Haven Protocol's public nodes are no longer available** (project shut down Dec 2024). To sync and see balances you must run your own **Haven daemon** (from `haven-main`) or use a community node.

1. **Run a Haven daemon** (in a separate terminal), e.g. from your build dir: `./haven daemon` (listens on port **17750**).
2. **Start the wallet RPC** with that daemon: `HAVEN_DAEMON_ADDRESS=http://localhost:17750 ./start-wallet-rpc.sh`
3. In the app **Settings**, set **Daemon URL** to the same address (e.g. `http://localhost:17750`) and click **Save & connect**.

### "Wallet RPC unreachable" / ECONNRESET / "Address already in use"

**Local nodes only** — there are no public Haven nodes. You must run **havend** (daemon, port 17750) and **haven-wallet-rpc** (port 27750) on your machine.

- **"Address already in use"** when running `./start-wallet-rpc.sh` means **haven-wallet-rpc is already running**. You don’t need to start it again — open the app, set **Settings → Wallet RPC URL** to `http://localhost:27750`, and use the app. To restart the wallet RPC: `pkill -f haven-wallet-rpc`, then run `HAVEN_DAEMON_ADDRESS=http://localhost:17750 ./start-wallet-rpc.sh` again.
- If you see "Wallet RPC unreachable" or "read ECONNRESET", the app retries automatically. Ensure both daemon and wallet RPC are running. If port 27750 is in use by something else, run `HAVEN_WALLET_RPC_PORT=27751 ./start-wallet-rpc.sh` and set **Settings → Wallet RPC URL** to `http://localhost:27751`.

1. **Build** the wallet RPC from `haven-main` (if you haven’t):
   ```bash
   cd haven-main
   make release
   ```
   Binary: `build/<OS>/release/haven-wallet-rpc`.

2. **Start** the wallet RPC **before** using the app. Two options:

   **Option A – Helper script:** You must set `HAVEN_DAEMON_ADDRESS` (no public nodes):
   ```bash
   cd monerousd-desktop
   chmod +x start-wallet-rpc.sh
   HAVEN_DAEMON_ADDRESS=http://localhost:17750 ./start-wallet-rpc.sh
   ```
   If 27750 is in use: `HAVEN_WALLET_RPC_PORT=27751 ./start-wallet-rpc.sh` and set the app URL to `http://localhost:27751`.

   **Option B – Manual:**
   ```bash
   # From haven-main build dir, or put haven-wallet-rpc in PATH
   # Daemon port is usually 17750 (Haven node); wallet RPC default 27750.
   ./haven-wallet-rpc --rpc-bind-port=27750 --wallet-dir=/path/to/wallet/dir --daemon-address=http://YOUR_HAVEN_NODE:17750 --disable-rpc-login
   ```
   Use `--rpc-bind-port=27751` if 27750 is in use, and set the app’s Wallet RPC URL accordingly.

3. In the app **Settings**, set **Daemon URL** (e.g. `http://localhost:17750`) and **Wallet RPC URL**, then **Save & connect**.

## Run the desktop app (Electron)

```bash
cd monerousd-desktop
npm install
npm start
```

In the app: open **Settings**, set the RPC URL if needed (e.g. `http://localhost:27750`), click **Save & connect**. Then use Dashboard, Send, Receive, Swap, and History.

### CLI shows balance but app shows 0.00

The app does **not** have access to your view keys. It only calls **haven-wallet-rpc** (`get_balance`, `get_transfers`, etc.). The RPC uses your wallet’s view keys when it runs **refresh** (scanning the chain); the frontend just displays what `get_balance` returns.

If the **CLI** (e.g. haven-wallet-cli) shows a balance but the **app** shows 0.00, they are usually using **different wallet instances**:

- **CLI** = one process (e.g. `haven-wallet-cli` with a wallet file).
- **App** = talks to **haven-wallet-rpc**, which has its **own** open wallet (the one you started it with or imported in the app).

To see the **same** balance in the app as in the CLI:

1. **Use the same wallet in the RPC:** Start **haven-wallet-rpc** with the **same** wallet file the CLI uses, e.g.  
   `./haven-wallet-rpc --rpc-bind-port=27750 --wallet-file=/path/to/YourWallet --daemon-address=...`  
   Then open the app (no need to import again). The app will show the same balance once the RPC has synced that wallet.

2. **Or import the same seed in the app:** If you use **Import from seed**, restore the **same** 25-word seed. Then in the app click **Refresh (↻)** and wait until the wallet has synced with the daemon. Until sync completes, `get_balance` can still be 0.

In both cases, ensure **Daemon URL** in Settings points to a running Haven daemon so the RPC can refresh.

## Run in browser

You can use the same UI in your browser (no Electron). **Run these commands from the repo root** (e.g. `MoneroUSD`), or use the full path to `monerousd-desktop`:

```bash
cd monerousd-desktop
npm install
npm run browser
```

Or start the server directly (must be run from inside `monerousd-desktop`):

```bash
cd monerousd-desktop
node server.js
```

Then open **http://localhost:3000** in your browser. The server proxies RPC to the URL in Settings (default `http://localhost:27750`).

**Browser console:** If you see `[PHANTOM]` or "Receiving end does not exist" / "Could not establish connection" in the dev console, those messages come from a **browser extension** (e.g. Phantom wallet) injecting into the page. They are harmless for this app and can be ignored, or disable the extension for localhost.

To use a different wallet RPC port without changing Settings, set the env when starting the server:

```bash
cd monerousd-desktop
WALLET_RPC_URL=http://localhost:27750 node server.js
```

## Swap (XMR ↔ USDm)

The **Swap** tab shows:

- **XMR → USDm**: Enter XMR amount and USD price to see the USDm quote; run `swap_xmr_to_usdm <xmr_amount> <xmr_usd_price>` in the CLI for full instructions.
- **USDm → XMR**: Enter USDm amount, your XMR address, and price; run `swap_usdm_to_xmr <usdm_amount> <xmr_address> <xmr_usd_price>` in the CLI to execute.

Configure swap provider addresses in the CLI with `set swap_provider_usdm_address` and `set swap_provider_xmr_address`.

## E2E tests (dashboard USDm balance)

To verify the USDm balance updates on the dashboard after load and after Refresh:

1. Start the app server and wallet RPC (and optionally havend): `node server.js`, `HAVEN_DAEMON_ADDRESS=http://localhost:17750 ./start-wallet-rpc.sh`
2. Run: `npm run test:e2e` (or `npx playwright test tests/dashboard-balance.spec.js`)

The tests open the app in a headless browser, assert the balance element shows a valid value after load, then click Refresh and assert the balance still updates correctly.

## Build distributable

```bash
npm run build        # current platform
npm run build:mac    # macOS
```

Output is in `dist/`.
