# GIWA Swap

A public swap app for [Ammora](https://ammora.org) launches on GIWA Sepolia. Quotes and swap transactions are built with [`@ammora-protocol/sdk`](https://www.npmjs.com/package/@ammora-protocol/sdk) `0.3.9`. The visitor's own wallet signs every approval and swap. There is no backend and no private key in the site.

Live app: [https://blackcapeth.github.io/giwa-swap/](https://blackcapeth.github.io/giwa-swap/)

## What you can do

- Connect an injected wallet (MetaMask and other EIP-1193 wallets) and add or switch to GIWA Sepolia.
- Browse Ammora launches. A saved list is shown immediately, then the app checks a recent factory-log window and the Ammora data API (`https://ammora-giwa-sepolia-data.fly.dev`) with a short timeout. Results are cached in the browser.
- Click a launch to prefill the swap. USD prices are shown when the data API returns them.
- Get a live exact-input quote from `AmmoraRouteClient`, including the SDK minimum out for the selected slippage. If the route client cannot price a graduated pool, the app asks `AmmoraSwapClient` for the same quote so the contract error is visible.
- Approve the pool when the allowance is short, then send the swap. `AmmoraSwapClient.prepareExactIn` builds the transaction and `PreparedExactInputSwap.execute` asks the connected wallet to sign.

## Network

| | |
| --- | --- |
| Chain | GIWA Sepolia |
| Chain id | 91342 |
| RPC | `https://sepolia-rpc.giwa.io` |
| Explorer | `https://sepolia-explorer.giwa.io` |
| Deployment | `giwaSepoliaAutoRouteDeployment` (V4 auto-route) |

The app uses that catalog, `giwaSepoliaAutoRoute`, `giwaSepoliaAutoRouteCatalog`, `giwaSepoliaAutoRouteDeploymentCatalog`, and `giwaSepoliaAutoRoutePoolProfiles`. It does not mix in the legacy V3 registry.

## Local development

Node 22 or newer.

```bash
npm install
npm run dev
```

The Vite base path is `/giwa-swap/`, matching GitHub Pages. `npm run build` typechecks and writes `dist/`. `npm run quote` requests one read-only quote against GIWA Sepolia. It does not sign or send a transaction.

## Deploy

Pushes to `main` run `.github/workflows/pages.yml`. The workflow uses `actions/configure-pages`, `actions/upload-pages-artifact`, and `actions/deploy-pages`. GitHub Pages is set to deploy from GitHub Actions.
