/**
 * Read-only quote check. No wallet and no private key.
 *
 *   node scripts/quote-check.mjs
 *
 * Discovers a trading launch through AmmoraDataApiClient, or from V4 factory
 * logs when the data API is unavailable, then quotes 0.001 of the quote token
 * with AmmoraRouteClient.
 */
import {
  AmmoraDataApiClient,
  AmmoraRouteClient,
  ammoraLaunchFactoryV4Abi,
  ammoraLaunchPoolV4Abi,
  giwaSepoliaAutoRoute,
  giwaSepoliaAutoRouteCatalog,
  giwaSepoliaAutoRouteDeployment,
  giwaSepoliaAutoRouteDeploymentCatalog,
  giwaSepoliaAutoRoutePoolProfiles,
  resolveAmmoraFinalizedHead,
} from "@ammora-protocol/sdk";
import {
  createPublicClient,
  defineChain,
  erc20Abi,
  formatUnits,
  getAbiItem,
  http,
  zeroAddress,
} from "viem";

const deployment = giwaSepoliaAutoRouteDeployment;
const rpc = deployment.chain.rpcUrls[0];
const chain = defineChain({
  id: deployment.chain.id,
  name: deployment.chain.name,
  nativeCurrency: deployment.chain.nativeCurrency,
  rpcUrls: { default: { http: [rpc] } },
});
const client = createPublicClient({ chain, transport: http(rpc, { timeout: 20_000 }) });
const factory = deployment.contracts.launch.factory;
const event = getAbiItem({ abi: ammoraLaunchFactoryV4Abi, name: "LaunchCreated" });

const launches = await discover();
const tradable = [];
for (const launch of launches) {
  const [status, quoteToken, baseToken, symbol, decimals] = await Promise.all([
    client.readContract({ address: launch.curve, abi: ammoraLaunchPoolV4Abi, functionName: "status" }),
    client.readContract({ address: launch.curve, abi: ammoraLaunchPoolV4Abi, functionName: "quoteToken" }),
    client.readContract({ address: launch.curve, abi: ammoraLaunchPoolV4Abi, functionName: "baseToken" }),
    client.readContract({ address: launch.token, abi: erc20Abi, functionName: "symbol" }),
    client.readContract({ address: launch.token, abi: erc20Abi, functionName: "decimals" }),
  ]);
  if (status === 1 && baseToken.toLowerCase() === launch.token.toLowerCase() && quoteToken !== zeroAddress) {
    tradable.push({ ...launch, quoteToken, symbol, decimals });
  }
}
if (tradable.length === 0) throw new Error("No active launch curve was found to quote.");

const market = tradable[0];
const verificationBlock = await resolveAmmoraFinalizedHead([client], giwaSepoliaAutoRoute.finality);
const routes = await AmmoraRouteClient.create({
  client,
  routeCatalog: giwaSepoliaAutoRouteCatalog,
  deploymentCatalog: giwaSepoliaAutoRouteDeploymentCatalog,
  factoryProfiles: giwaSepoliaAutoRoutePoolProfiles,
  pools: [{ model: "dbc", pool: market.curve, baseToken: market.token, quoteToken: market.quoteToken }],
  verificationBlock,
});
const amountIn = 10n ** 15n;
const quote = await routes.quoteExactIn({
  tokenIn: market.quoteToken,
  tokenOut: market.token,
  amountIn,
  slippageBps: 50,
});
console.log(JSON.stringify({
  chainId: deployment.chain.id,
  slot: deployment.slot,
  symbol: market.symbol,
  curve: market.curve,
  token: market.token,
  quoteToken: market.quoteToken,
  amountIn: amountIn.toString(),
  expectedAmountOut: quote.expectedAmountOut.toString(),
  minimumAmountOut: quote.minimumAmountOut.toString(),
  expectedDisplay: formatUnits(quote.expectedAmountOut, Number(market.decimals)),
  minimumDisplay: formatUnits(quote.minimumAmountOut, Number(market.decimals)),
  model: quote.hops[0]?.model ?? null,
  pool: quote.hops[0]?.pool ?? null,
  quoteBlockNumber: quote.quoteBlockNumber.toString(),
}, null, 2));

async function discover() {
  try {
    const data = new AmmoraDataApiClient("https://ammora-giwa-sepolia-data.fly.dev");
    const page = await data.getLaunches({ chainId: 91342n, signal: AbortSignal.timeout(12_000) });
    if (page.items.length > 0) {
      console.error(`data-api launches: ${page.items.length}`);
      return page.items.map((item) => ({
        token: item.address,
        curve: item.curveAddress,
      }));
    }
  } catch (error) {
    console.error(`data-api skipped: ${error instanceof Error ? error.message : "unavailable"}`);
  }

  const head = await client.getBlockNumber();
  const span = 9_000n;
  const found = [];
  let cursor = head;
  for (let step = 0; step < 24 && cursor > deployment.startBlock && found.length < 12; step += 1) {
    const jobs = [];
    for (let index = 0; index < 8 && cursor > deployment.startBlock; index += 1) {
      const to = cursor;
      const from = to - span + 1n < deployment.startBlock ? deployment.startBlock : to - span + 1n;
      cursor = from - 1n;
      jobs.push(client.getLogs({ address: factory, event, fromBlock: from, toBlock: to }));
    }
    const batches = await Promise.all(jobs);
    for (const logs of batches) {
      for (const log of logs) {
        if (log.args.token && log.args.curve) found.push({ token: log.args.token, curve: log.args.curve });
      }
    }
  }
  console.error(`factory-log launches: ${found.length}`);
  return found;
}
