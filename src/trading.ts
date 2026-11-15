import {
  AmmoraRouteClient,
  AmmoraSwapClient,
  giwaSepoliaAutoRoute,
  giwaSepoliaAutoRouteCatalog,
  giwaSepoliaAutoRouteDeploymentCatalog,
  giwaSepoliaAutoRoutePoolProfiles,
  resolveAmmoraFinalizedHead,
  type AmmoraSwapModel,
  type ERC20ApprovalRequirement,
} from "@ammora-protocol/sdk";
import {
  erc20Abi,
  type Address,
  type Hash,
  type WalletClient,
} from "viem";
import { publicClient } from "./chain";
import type { Market } from "./markets";

export type QuoteView = {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  expectedAmountOut: bigint;
  minimumAmountOut: bigint;
  priceImpactBps: bigint | null;
  feeAmount: bigint | null;
  feeToken: Address | null;
  quoteBlockNumber: bigint;
  expiresAtMs: number;
  pool: Address;
  model: AmmoraSwapModel;
  approvals: readonly ERC20ApprovalRequirement[];
};

const SWAP_MODELS = new Set<AmmoraSwapModel>(["almm", "concentrated", "compounding", "dbc"]);

let swapClientPromise: Promise<AmmoraSwapClient> | null = null;
const routeCache = new Map<string, { at: number; client: Promise<AmmoraRouteClient> }>();

function getSwapClient(): Promise<AmmoraSwapClient> {
  swapClientPromise ??= AmmoraSwapClient.create(publicClient, {
    deploymentCatalog: giwaSepoliaAutoRouteDeploymentCatalog,
    factoryProfiles: giwaSepoliaAutoRoutePoolProfiles,
  });
  return swapClientPromise;
}

function getRouteClient(market: Market): Promise<AmmoraRouteClient> {
  const key = `${market.model}:${market.tradablePool.toLowerCase()}`;
  const cached = routeCache.get(key);
  if (cached && Date.now() - cached.at < 40_000) return cached.client;
  const client = (async () => {
    const verificationBlock = await resolveAmmoraFinalizedHead(
      [publicClient],
      giwaSepoliaAutoRoute.finality,
    );
    return AmmoraRouteClient.create({
      client: publicClient,
      routeCatalog: giwaSepoliaAutoRouteCatalog,
      deploymentCatalog: giwaSepoliaAutoRouteDeploymentCatalog,
      factoryProfiles: giwaSepoliaAutoRoutePoolProfiles,
      pools: [
        {
          model: market.model,
          pool: market.tradablePool,
          baseToken: market.token,
          quoteToken: market.quoteToken,
        },
      ],
      verificationBlock,
    });
  })();
  routeCache.set(key, { at: Date.now(), client });
  client.catch(() => routeCache.delete(key));
  return client;
}

export function findMarket(
  markets: readonly Market[],
  tokenIn: Address,
  tokenOut: Address,
): Market | null {
  const left = tokenIn.toLowerCase();
  const right = tokenOut.toLowerCase();
  const matches = markets.filter((market) => {
    const base = market.token.toLowerCase();
    const quote = market.quoteToken.toLowerCase();
    return (base === left && quote === right) || (base === right && quote === left);
  });
  return (
    matches.find((market) => market.status === 1) ??
    matches.find((market) => market.status === 3) ??
    matches[0] ??
    null
  );
}

export async function quoteMarket(input: {
  market: Market;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  slippageBps: number;
}): Promise<QuoteView> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await quoteMarketOnce(input);
    } catch (error) {
      last = error;
      const message = error instanceof Error ? error.message : "";
      if (!/429|rate limit|over rate/i.test(message) || attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2_000 * (attempt + 1)));
    }
  }
  throw last;
}

async function quoteMarketOnce(input: {
  market: Market;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  slippageBps: number;
}): Promise<QuoteView> {
  if (input.market.status === 2) {
    throw new Error("This curve is ready to migrate. Trading resumes after the graduated pool is created.");
  }
  if (input.market.status === 0) {
    throw new Error("This launch is not active yet.");
  }

  try {
    const routes = await getRouteClient(input.market);
    const quote = await routes.quoteExactIn({
      tokenIn: input.tokenIn,
      tokenOut: input.tokenOut,
      amountIn: input.amountIn,
      slippageBps: input.slippageBps,
    });
    const hop = quote.hops[0];
    if (!hop || !isSwapModel(hop.model)) {
      throw new Error("No direct swap route for this pair.");
    }
    return {
      tokenIn: quote.tokenIn,
      tokenOut: quote.tokenOut,
      amountIn: quote.amountIn,
      expectedAmountOut: quote.expectedAmountOut,
      minimumAmountOut: quote.minimumAmountOut,
      priceImpactBps: quote.priceImpactBps,
      feeAmount: quote.fees.total,
      feeToken: quote.fees.token,
      quoteBlockNumber: quote.quoteBlockNumber,
      expiresAtMs: quote.expiresAtMs,
      pool: hop.pool,
      model: hop.model,
      approvals: quote.approvals,
    };
  } catch (routeError) {
    const swaps = await getSwapClient();
    try {
      const prepared = await swaps.prepareExactIn({
        model: input.market.model,
        pool: input.market.tradablePool,
        tokenIn: input.tokenIn,
        amountIn: input.amountIn,
        payer: "0x0000000000000000000000000000000000000001",
        recipient: "0x0000000000000000000000000000000000000001",
        slippageBps: input.slippageBps,
        executionMode: "direct-wallet",
      });
      if (prepared.quote.tokenOut.toLowerCase() !== input.tokenOut.toLowerCase()) {
        throw routeError;
      }
      return {
        tokenIn: prepared.quote.tokenIn,
        tokenOut: prepared.quote.tokenOut,
        amountIn: prepared.quote.amountIn,
        expectedAmountOut: prepared.quote.expectedAmountOut,
        minimumAmountOut: prepared.quote.minimumAmountOut,
        priceImpactBps: prepared.quote.priceImpactBps,
        feeAmount: prepared.quote.feeAmount,
        feeToken: prepared.quote.feeToken,
        quoteBlockNumber: prepared.quote.quoteBlockNumber,
        expiresAtMs: prepared.quote.expiresAtMs,
        pool: prepared.quote.pool,
        model: prepared.quote.model,
        approvals: prepared.approvalRequirements,
      };
    } catch (swapError) {
      if (routeError instanceof Error && /No route|not active|ready to migrate/i.test(routeError.message)) {
        throw swapError;
      }
      throw swapError instanceof Error ? swapError : routeError;
    }
  }
}

function isSwapModel(model: string): model is AmmoraSwapModel {
  return SWAP_MODELS.has(model as AmmoraSwapModel);
}

export async function approvalStillNeeded(
  owner: Address,
  approvals: readonly ERC20ApprovalRequirement[],
): Promise<boolean> {
  if (approvals.length === 0) return false;
  const allowances = await Promise.all(
    approvals.map((approval) =>
      publicClient.readContract({
        address: approval.token,
        abi: erc20Abi,
        functionName: "allowance",
        args: [owner, approval.spender],
      }),
    ),
  );
  return approvals.some((approval, index) => allowances[index] < approval.amount);
}

export async function executeQuotedSwap(input: {
  quote: QuoteView;
  account: Address;
  wallet: WalletClient;
  slippageBps: number;
  onPhase: (phase: "approving" | "swapping") => void;
}): Promise<{ hash: Hash; approvalHashes: readonly Hash[]; amountReceived: bigint | null }> {
  const swaps = await getSwapClient();
  const prepared = await swaps.prepareExactIn({
    model: input.quote.model,
    pool: input.quote.pool,
    tokenIn: input.quote.tokenIn,
    amountIn: input.quote.amountIn,
    payer: input.account,
    recipient: input.account,
    slippageBps: input.slippageBps,
    executionMode: "direct-wallet",
  });
  const result = await prepared.execute(input.wallet, {
    sendApprovals: true,
    exactApproval: true,
    simulate: true,
    autoRefresh: true,
    onStatus: (status) => {
      if (status.type.startsWith("approval")) input.onPhase("approving");
      if (status.type.startsWith("swap")) input.onPhase("swapping");
    },
  });
  return {
    hash: result.hash,
    approvalHashes: result.approvalHashes,
    amountReceived: result.amountReceived,
  };
}
