import {
  AmmoraDataApiClient,
  AmmoraDataApiError,
  ammoraLaunchFactoryV4Abi,
  ammoraLaunchPoolV4Abi,
  ammoraV3ExecutionRegistryAbi,
  type AmmoraLaunchFeedItem,
  type AmmoraUsdPrice,
} from "@ammora-protocol/sdk";
import {
  erc20Abi,
  getAbiItem,
  getAddress,
  zeroAddress,
  type Address,
} from "viem";
import { DATA_API_URL, deployment, publicClient } from "./chain";
import { explainError } from "./errors";

export type SwapModel = "dbc" | "concentrated" | "compounding";

export type Market = {
  token: Address;
  curve: Address;
  creator: Address;
  quoteToken: Address;
  canonicalPool: Address | null;
  model: SwapModel;
  tradablePool: Address;
  status: number;
  symbol: string;
  name: string;
  decimals: number;
  quoteSymbol: string;
  quoteName: string;
  quoteDecimals: number;
  priceUsd: number | null;
  imageUrl: string | null;
  createdBlock: string | null;
};

export type MarketSource = "data-api" | "factory-logs";

export type Discovery = {
  markets: Market[];
  source: MarketSource;
  notice: string | null;
};

const launchCreatedEvent = getAbiItem({
  abi: ammoraLaunchFactoryV4Abi,
  name: "LaunchCreated",
});

const factory = deployment.contracts.launch.factory;
const executionRegistry = deployment.contracts.routers.executionRegistry;

export async function discoverMarkets(
  onStatus?: (message: string) => void,
): Promise<Discovery> {
  onStatus?.("Loading Ammora launches…");
  const logsPromise = marketsFromFactoryLogs(onStatus);
  try {
    const markets = await marketsFromDataApi();
    return { markets, source: "data-api", notice: null };
  } catch (error) {
    onStatus?.("Data API unavailable. Reading V4 factory logs…");
    const markets = await logsPromise;
    const detail = explainError(error);
    return {
      markets,
      source: "factory-logs",
      notice: `The Ammora data API did not respond (${detail}). This list was read from LaunchCreated logs on the auto-route V4 factory. Prices appear when the indexer is available.`,
    };
  }
}

async function marketsFromDataApi(): Promise<Market[]> {
  const data = new AmmoraDataApiClient(DATA_API_URL);
  const signal = AbortSignal.timeout(2_500);
  const summaries = [];
  let cursor: string | undefined;
  for (let page = 0; page < 6; page += 1) {
    const result = await data.getLaunches({
      chainId: 91342n,
      cursor,
      signal,
    });
    summaries.push(...result.items.filter((item) => !item.blacklisted));
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }

  const [feed, prices] = await Promise.all([
    data.getLaunchFeed({ chainId: 91342n, signal }).catch(() => null),
    data.getUsdPrices({ chainId: 91342n, signal }).catch(() => [] as AmmoraUsdPrice[]),
  ]);

  const feedByToken = new Map<string, AmmoraLaunchFeedItem>();
  for (const item of feed?.items ?? []) {
    feedByToken.set(item.tokenAddress.toLowerCase(), item);
  }
  const priceByToken = new Map<string, number | null>();
  for (const price of prices) {
    priceByToken.set(price.tokenAddress.toLowerCase(), usdFromPrice(price));
  }

  const seeds = summaries.map((item) => ({
    token: getAddress(item.address),
    curve: getAddress(item.curveAddress),
    creator: getAddress(item.creatorAddress),
    createdBlock: item.createdBlock,
    imageUrl: feedByToken.get(item.address.toLowerCase())?.imageUrl ?? null,
    feedName: feedByToken.get(item.address.toLowerCase())?.name ?? null,
    feedSymbol: feedByToken.get(item.address.toLowerCase())?.symbol ?? null,
    priceUsd: priceByToken.get(item.address.toLowerCase()) ?? null,
  }));

  return hydrateMarkets(seeds);
}

async function marketsFromFactoryLogs(
  onStatus?: (message: string) => void,
): Promise<Market[]> {
  const head = await publicClient.getBlockNumber();
  const span = 9_000n;
  const floor = deployment.startBlock;
  let cursor = head;
  const found: Array<{
    token: Address;
    curve: Address;
    creator: Address;
    createdBlock: string;
  }> = [];
  let failures = 0;

  for (let step = 0; step < 56 && cursor > floor && found.length < 12; step += 1) {
    const ranges: Array<{ from: bigint; to: bigint }> = [];
    for (let index = 0; index < 3 && cursor > floor; index += 1) {
      const to = cursor;
      const from = to - span + 1n < floor ? floor : to - span + 1n;
      cursor = from - 1n;
      ranges.push({ from, to });
    }
    const batches = await Promise.all(ranges.map((range) => readLaunchLogs(range.from, range.to)));
    for (const logs of batches) {
      if (logs === null) {
        failures += 1;
        continue;
      }
      for (const log of logs) {
        if (!log.args.token || !log.args.curve || !log.args.creator) continue;
        found.push({
          token: getAddress(log.args.token),
          curve: getAddress(log.args.curve),
          creator: getAddress(log.args.creator),
          createdBlock: log.blockNumber.toString(),
        });
      }
    }
    if (failures > 8) {
      throw new Error("GIWA Sepolia RPC is rate limiting log requests. Wait a moment and refresh.");
    }
    onStatus?.(`Reading factory logs… ${found.length} launch${found.length === 1 ? "" : "es"} so far`);
    await sleep(40);
  }

  const unique = new Map<string, (typeof found)[number]>();
  for (const item of found) unique.set(item.token.toLowerCase(), item);
  const seeds = [...unique.values()].map((item) => ({
    ...item,
    imageUrl: null,
    feedName: null,
    feedSymbol: null,
    priceUsd: null,
  }));
  return hydrateMarkets(seeds);
}

async function readLaunchLogs(from: bigint, to: bigint) {
  let delay = 600;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await publicClient.getLogs({
        address: factory,
        event: launchCreatedEvent,
        fromBlock: from,
        toBlock: to,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const limited = /429|rate limit|over rate|timeout/i.test(message);
      if (!limited || attempt === 4) return null;
      await sleep(delay);
      delay *= 2;
    }
  }
  return null;
}

async function readWithRetry<T>(read: () => Promise<T>, attempts = 4): Promise<T> {
  let delay = 500;
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await read();
    } catch (error) {
      last = error;
      if (attempt === attempts - 1) break;
      await sleep(delay);
      delay *= 2;
    }
  }
  throw last;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type Seed = {
  token: Address;
  curve: Address;
  creator: Address;
  createdBlock: string | null;
  imageUrl: string | null;
  feedName: string | null;
  feedSymbol: string | null;
  priceUsd: number | null;
};

async function hydrateMarkets(seeds: Seed[]): Promise<Market[]> {
  if (seeds.length === 0) return [];

  const partial = (
    await mapLimited(seeds, 2, async (seed) => {
      try {
        const [status, quoteToken, baseToken, canonical] = await Promise.all([
          publicClient.readContract({ address: seed.curve, abi: ammoraLaunchPoolV4Abi, functionName: "status" }),
          publicClient.readContract({ address: seed.curve, abi: ammoraLaunchPoolV4Abi, functionName: "quoteToken" }),
          publicClient.readContract({ address: seed.curve, abi: ammoraLaunchPoolV4Abi, functionName: "baseToken" }),
          publicClient.readContract({ address: seed.curve, abi: ammoraLaunchPoolV4Abi, functionName: "canonicalPool" }),
        ]);
        const statusCode = asNumber(status);
        if (statusCode === null || getAddress(baseToken) !== seed.token) return null;
        const canonicalPool =
          getAddress(canonical) === zeroAddress ? null : getAddress(canonical);
        return {
          ...seed,
          status: statusCode,
          quoteToken: getAddress(quoteToken),
          canonicalPool,
        };
      } catch {
        return null;
      }
    })
  ).filter((item): item is NonNullable<typeof item> => item !== null);

  const withKind = await mapLimited(partial, 3, async (item) => {
    let registryKind: number | null = null;
    if (item.status === 3 && item.canonicalPool) {
      try {
        const kind = await publicClient.readContract({
          address: executionRegistry,
          abi: ammoraV3ExecutionRegistryAbi,
          functionName: "poolKind",
          args: [item.canonicalPool],
        });
        registryKind = Array.isArray(kind) ? Number(kind[0]) : null;
      } catch {
        registryKind = null;
      }
    }
    return { ...item, registryKind };
  });

  const tokenSet = new Map<string, Address>();
  for (const item of withKind) {
    tokenSet.set(item.token.toLowerCase(), item.token);
    tokenSet.set(item.quoteToken.toLowerCase(), item.quoteToken);
  }
  const metas = (
    await mapLimited([...tokenSet.values()], 4, async (token) => {
      try {
        const [symbol, name, decimals] = await Promise.all([
          readWithRetry(() => publicClient.readContract({ address: token, abi: erc20Abi, functionName: "symbol" })).catch(() => ""),
          readWithRetry(() => publicClient.readContract({ address: token, abi: erc20Abi, functionName: "name" })).catch(() => "Token"),
          readWithRetry(() => publicClient.readContract({ address: token, abi: erc20Abi, functionName: "decimals" })),
        ]);
        const parsedDecimals = asNumber(decimals);
        if (parsedDecimals === null) return null;
        return {
          token,
          symbol: symbol || `${token.slice(0, 6)}…${token.slice(-4)}`,
          name: name || "Token",
          decimals: parsedDecimals,
        };
      } catch {
        return null;
      }
    })
  ).filter((item): item is NonNullable<typeof item> => item !== null);
  const metaByToken = new Map(metas.map((item) => [item.token.toLowerCase(), item]));

  const markets = withKind.flatMap((item): Market[] => {
    const base = metaByToken.get(item.token.toLowerCase());
    const quote = metaByToken.get(item.quoteToken.toLowerCase());
    if (!base || !quote) return [];
    const graduated = item.status === 3 && item.canonicalPool !== null;
    const model: SwapModel = graduated
      ? item.registryKind === 3
        ? "compounding"
        : "concentrated"
      : "dbc";
    return [
      {
        token: item.token,
        curve: item.curve,
        creator: item.creator,
        quoteToken: item.quoteToken,
        canonicalPool: item.canonicalPool,
        model,
        tradablePool: graduated && item.canonicalPool ? item.canonicalPool : item.curve,
        status: item.status,
        symbol: item.feedSymbol || base.symbol,
        name: item.feedName || base.name,
        decimals: base.decimals,
        quoteSymbol: quote.symbol,
        quoteName: quote.name,
        quoteDecimals: quote.decimals,
        priceUsd: item.priceUsd,
        imageUrl: item.imageUrl,
        createdBlock: item.createdBlock,
      },
    ];
  });

  return markets.sort((left, right) => {
    const rank = (status: number) => (status === 1 ? 0 : status === 3 ? 1 : 2);
    const byStatus = rank(left.status) - rank(right.status);
    if (byStatus !== 0) return byStatus;
    return Number(right.createdBlock ?? 0) - Number(left.createdBlock ?? 0);
  });
}

async function mapLimited<T, R>(items: readonly T[], limit: number, map: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await map(items[index] as T);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  return null;
}

function usdFromPrice(price: AmmoraUsdPrice): number | null {
  if (!price.usablePriceUsdE8 || !/^\d+$/.test(price.usablePriceUsdE8)) return null;
  const value = Number(price.usablePriceUsdE8) / 1e8;
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function isDataApiError(error: unknown): error is AmmoraDataApiError {
  return error instanceof AmmoraDataApiError;
}
