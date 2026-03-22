# MoneroUSD (USDm) Desktop Wallet

Private desktop wallet for **MoneroUSD (USDm)** — a stablecoin built on Monero's FCMP++ privacy technology.

Website: [monerousd.org](https://monerousd.org)

## Features

- **Dashboard** — USDm and XMR balances at a glance
- **Send** — Private USDm transactions shielded by FCMP++
- **Receive** — Generate and share your wallet address
- **Swap** — Exchange between XMR and USDm
- **Staking** — Earn yield by locking USDm (1.5%–6% APR)
- **Lending** — Borrow USDm against BTC/XMR collateral
- **History** — Full transaction history
- **Import** — Restore a wallet from your 25-word seed phrase
- **Auto-update** — OTA updates delivered automatically

## Quick Start

### Desktop App (Electron)

```bash
npm install
npm start
```

The app connects to the MoneroUSD network automatically. No manual node configuration required.

### Browser Version

```bash
npm install
npm run browser
```

Then open **http://localhost:3000** in your browser.

## Build

```bash
npm run build        # Linux + Windows
npm run build:mac    # macOS
```

Output is in `dist/`.

## Swap (XMR <> USDm)

The **Swap** tab provides quotes for exchanging between XMR and USDm. Enter the amount and current price to see the conversion rate.

## Network

- **Consensus:** Proof-of-Work (RandomX, CPU-mineable)
- **Block time:** ~120 seconds
- **Privacy:** FCMP++ (full-chain membership proofs)
- **Address prefix:** `Mo` (mainnet)

## License

See [LICENSE](LICENSE).

Portions Copyright (c) 2014-2024 The Monero Project.
