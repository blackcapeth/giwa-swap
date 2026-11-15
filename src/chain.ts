import { giwaSepoliaAutoRouteDeployment } from "@ammora-protocol/sdk";
import { createPublicClient, custom, defineChain, http, type PublicClient, type Transport } from "viem";

export const deployment = giwaSepoliaAutoRouteDeployment;

export const GIWA_CHAIN_ID = deployment.chain.id;
export const GIWA_RPC_URL = deployment.chain.rpcUrls[0];
export const GIWA_EXPLORER_URL = deployment.chain.blockExplorerUrl;
export const DATA_API_URL = "https://ammora-giwa-sepolia-data.fly.dev";
export const WRAPPED_NATIVE = deployment.contracts.tokens.wrappedNative;

export const giwaChain = defineChain({
  id: deployment.chain.id,
  name: deployment.chain.name,
  nativeCurrency: deployment.chain.nativeCurrency,
  rpcUrls: { default: { http: [GIWA_RPC_URL] } },
  blockExplorers: {
    default: { name: "GIWA Explorer", url: GIWA_EXPLORER_URL },
  },
});

/** Keep a few RPC calls in flight without bursting the public GIWA rate limit. */
export function pacedHttp(url: string, intervalMs = 60, maxInFlight = 4): Transport {
  let tail: Promise<unknown> = Promise.resolve();
  let nextStart = 0;
  let inFlight = 0;
  const waiters: Array<() => void> = [];
  return (parameters) => {
    const base = http(url, { retryCount: 0, timeout: 20_000 })(parameters);
    return custom({
      request: (args) => {
        const ready = tail.then(async () => {
          const wait = Math.max(0, nextStart - Date.now());
          nextStart = Date.now() + wait + intervalMs;
          if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
          while (inFlight >= maxInFlight) {
            await new Promise<void>((resolve) => waiters.push(resolve));
          }
          inFlight += 1;
        });
        tail = ready.catch(() => undefined);
        return ready.then(async () => {
          try {
            return await base.request(args);
          } finally {
            inFlight -= 1;
            waiters.shift()?.();
          }
        });
      },
    }, { retryCount: 0 })(parameters);
  };
}

export const publicClient: PublicClient = createPublicClient({
  chain: giwaChain,
  transport: pacedHttp(GIWA_RPC_URL),
});

export function explorerTx(hash: string): string {
  return `${GIWA_EXPLORER_URL}/tx/${hash}`;
}

export function explorerAddress(address: string): string {
  return `${GIWA_EXPLORER_URL}/address/${address}`;
}
