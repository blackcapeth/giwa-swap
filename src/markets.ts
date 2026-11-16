import {
  AmmoraDataApiClient,
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
import { DATA_API_URL, deployment, scanClient } from "./chain";
import seedMarketsJson from "./seed-markets.json";

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

export type MarketSource = "data-api" | "factory-logs" | "saved";

export type Discovery = {
  markets: Market[];
  source: MarketSource;
  notice: string | null;
  error: string | null;
};

const CACHE_KEY = "giwa-swap.markets.v1";
const RECENT_CHUNK = 8_000n;
const RECENT_CHUNKS = 8;
const DATA_API_TIMEOUT_MS = 1_200;

export const seededMarkets: Market[] = (seedMarketsJson as Market[]).filter(isMarket);

export function preferredMarket(markets: readonly Market[]): Market | null {
  return markets.find((market) => market.status === 1) ?? markets[0] ?? null;
}

export function mergeMarkets(base: readonly Market[], extra: readonly Market[]): Market[] {
  const map = new Map<string, Market>();
  for (const market of base) map.set(market.token.toLowerCase(), market);
  for (const market of extra) map.set(market.token.toLowerCase(), market);
  return [...map.values()].sort(compareMarkets);
}

export function loadCachedMarkets(): Market[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { markets?: unknown };
    if (!Array.isArray(parsed.markets)) return [];
    return parsed.markets.filter(isMarket);
  } catch {
    return [];
  }
}

export function saveCachedMarkets(markets: readonly Market[]): void {
  if (typeof localStorage === "undefined" || markets.length === 0) return;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ markets }));
  } catch {
    // Ignore quota and private-mode failures. The bundled list still renders.
  }
}

export function initialMarkets(): Market[] {
  return mergeMarkets(seededMarkets, loadCachedMarkets());
}

const launchCreatedEvent = getAbiItem({
  abi: ammoraLaunchFactoryV4Abi,
  name: "LaunchCreated",
});

const factory = deployment.contracts.launch.factory;
const executionRegistry = deployment.contracts.routers.executionRegistry;

export async function refreshMarkets(
  base: readonly Market[],
  handlers: {
    signal: AbortSignal;
    onStatus?: (message: string) => void;
    onMarkets: (markets: Market[]) => void;
  },
): Promise<Discovery> {
  let current = [...base];
  let sawFactory = false;
  const publish = (extra: readonly Market[]) => {
    if (handlers.signal.aborted || extra.length === 0) return;
    current = mergeMarkets(current, extra);
    handlers.onMarkets(current);
  };

  const scan = scanRecentWindow(current, handlers.signal, handlers.onStatus, (found) => {
    sawFactory = true;
    publish(found);
  });
  let apiMarkets: Market[] | null = null;
  let apiFailed = false;
  try {
    apiMarkets = await marketsFromDataApi(AbortSignal.any([handlers.signal, AbortSignal.timeout(DATA_API_TIMEOUT_MS)]));
    publish(apiMarkets);
  } catch {
    apiFailed = true;
  }
  await scan;

  if (current.length === 0) {
    return {
      markets: [],
      source: "saved",
      notice: null,
      error: "Launches could not be loaded in time. Try again.",
    };
  }
  if (!apiFailed && apiMarkets && apiMarkets.length > 0) {
    return { markets: current, source: "data-api", notice: null, error: null };
  }
  return {
    markets: current,
    source: sawFactory ? "factory-logs" : "saved",
    notice: "Indexer is unavailable. Showing saved launches.",
    error: null,
  };
}

async function marketsFromDataApi(signal: AbortSignal): Promise<Market[]> {
  const data = new AmmoraDataApiClient(DATA_API_URL);
  const summaries = [];
  let cursor: string | undefined;
  for (let page = 0; page < 2; page += 1) {
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

async function scanRecentWindow(
  known: readonly Market[],
  signal: AbortSignal,
  onStatus: ((message: string) => void) | undefined,
  onFound: (markets: Market[]) => void,
): Promise<void> {
  const head = await scanClient.getBlockNumber();
  if (signal.aborted) return;
  const knownNewest = known.reduce((max, market) => {
    const block = BigInt(market.createdBlock ?? "0");
    return block > max ? block : max;
  }, 0n);
  const windowFloor = head - RECENT_CHUNK * BigInt(RECENT_CHUNKS) + 1n;
  const floor = knownNewest + 1n > windowFloor ? knownNewest + 1n : windowFloor;
  if (floor > head) return;
  const seen = new Set(known.map((market) => market.token.toLowerCase()));
  let cursor = head;
  let failures = 0;
  let found = 0;

  while (cursor > floor && !signal.aborted) {
    const ranges: Array<{ from: bigint; to: bigint }> = [];
    for (let index = 0; index < 2 && cursor > floor; index += 1) {
      const to = cursor;
      const from = to - RECENT_CHUNK + 1n < floor ? floor : to - RECENT_CHUNK + 1n;
      cursor = from - 1n;
      ranges.push({ from, to });
    }
    const batches = await Promise.all(ranges.map((range) => readLaunchLogs(range.from, range.to)));
    const seeds: Seed[] = [];
    for (const logs of batches) {
      if (logs === null) {
        failures += 1;
        continue;
      }
      for (const log of logs) {
        if (!log.args.token || !log.args.curve || !log.args.creator) continue;
        const token = getAddress(log.args.token);
        if (seen.has(token.toLowerCase())) continue;
        seen.add(token.toLowerCase());
        seeds.push({
          token,
          curve: getAddress(log.args.curve),
          creator: getAddress(log.args.creator),
          createdBlock: log.blockNumber.toString(),
          imageUrl: null,
          feedName: null,
          feedSymbol: null,
          priceUsd: null,
        });
      }
    }
    if (failures > 3) return;
    if (seeds.length > 0 && !signal.aborted) {
      const hydrated = await hydrateMarkets(seeds);
      found += hydrated.length;
      if (hydrated.length > 0) onFound(hydrated);
    }
    onStatus?.(`Checking recent blocks… ${found} new launch${found === 1 ? "" : "es"}`);
  }
}

async function readLaunchLogs(from: bigint, to: bigint) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await scanClient.getLogs({
        address: factory,
        event: launchCreatedEvent,
        fromBlock: from,
        toBlock: to,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const limited = /429|rate limit|over rate|timeout/i.test(message);
      if (!limited || attempt === 1) return null;
      await sleep(400);
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
          scanClient.readContract({ address: seed.curve, abi: ammoraLaunchPoolV4Abi, functionName: "status" }),
          scanClient.readContract({ address: seed.curve, abi: ammoraLaunchPoolV4Abi, functionName: "quoteToken" }),
          scanClient.readContract({ address: seed.curve, abi: ammoraLaunchPoolV4Abi, functionName: "baseToken" }),
          scanClient.readContract({ address: seed.curve, abi: ammoraLaunchPoolV4Abi, functionName: "canonicalPool" }),
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
        const kind = await scanClient.readContract({
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
          readWithRetry(() => scanClient.readContract({ address: token, abi: erc20Abi, functionName: "symbol" })).catch(() => ""),
          readWithRetry(() => scanClient.readContract({ address: token, abi: erc20Abi, functionName: "name" })).catch(() => "Token"),
          readWithRetry(() => scanClient.readContract({ address: token, abi: erc20Abi, functionName: "decimals" })),
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

  return markets.sort(compareMarkets);
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

function compareMarkets(left: Market, right: Market): number {
  const rank = (status: number) => (status === 1 ? 0 : status === 3 ? 1 : 2);
  const byStatus = rank(left.status) - rank(right.status);
  if (byStatus !== 0) return byStatus;
  return Number(right.createdBlock ?? 0) - Number(left.createdBlock ?? 0);
}

function isMarket(value: unknown): value is Market {
  if (!value || typeof value !== "object") return false;
  const market = value as Market;
  return (
    typeof market.token === "string" &&
    typeof market.curve === "string" &&
    typeof market.quoteToken === "string" &&
    typeof market.tradablePool === "string" &&
    typeof market.symbol === "string" &&
    typeof market.decimals === "number" &&
    typeof market.quoteDecimals === "number" &&
    (market.model === "dbc" || market.model === "concentrated" || market.model === "compounding") &&
    typeof market.status === "number"
  );
}
