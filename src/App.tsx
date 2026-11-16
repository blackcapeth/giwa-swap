import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Address } from "viem";
import { GIWA_CHAIN_ID, deployment } from "./chain";
import { Footer } from "./components/Footer";
import { Header } from "./components/Header";
import { MarketList } from "./components/MarketList";
import { SwapCard, type TokenChoice } from "./components/SwapCard";
import { explainError } from "./errors";
import { amountDraft, formatAmount, formatBps, parseAmount, shortAddress } from "./format";
import {
  initialMarkets,
  preferredMarket,
  refreshMarkets,
  saveCachedMarkets,
  type Market,
  type MarketSource,
} from "./markets";
import { approvalStillNeeded, executeQuotedSwap, findMarket, quoteMarket, warmRoute, type QuoteView } from "./trading";
import {
  connectWallet,
  formatEth,
  getInjected,
  readEthBalance,
  readTokenBalance,
  readWallet,
  switchToGiwa,
  walletClientFor,
} from "./wallet";

const REFRESH_BUDGET_MS = 8_000;

export function App() {
  const [markets, setMarkets] = useState<Market[]>(() => initialMarkets());
  const [source, setSource] = useState<MarketSource | null>("saved");
  const [notice, setNotice] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [listStatus, setListStatus] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(() => initialMarkets().length === 0);
  const [reloadKey, setReloadKey] = useState(0);

  const [tokenIn, setTokenIn] = useState<Address | null>(() => preferredMarket(initialMarkets())?.quoteToken ?? null);
  const [tokenOut, setTokenOut] = useState<Address | null>(() => preferredMarket(initialMarkets())?.token ?? null);
  const [amount, setAmount] = useState("0.001");
  const [slippageBps, setSlippageBps] = useState(50);

  const [quote, setQuote] = useState<QuoteView | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [needsApproval, setNeedsApproval] = useState(false);

  const [account, setAccount] = useState<Address | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [ethBalance, setEthBalance] = useState<bigint | null>(null);
  const [payBalance, setPayBalance] = useState<bigint | null>(null);
  const [walletBusy, setWalletBusy] = useState(false);
  const [walletNote, setWalletNote] = useState<string | null>(null);

  const [phase, setPhase] = useState<"idle" | "preparing" | "approving" | "swapping" | "done">("idle");
  const [swapError, setSwapError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{ hash: string; approvalHashes: readonly string[] } | null>(null);

  const requestId = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    const budget = window.setTimeout(() => controller.abort(), REFRESH_BUDGET_MS);
    let alive = true;
    setListError(null);
    setListStatus("Checking for new launches…");
    if (markets.length === 0) setListLoading(true);
    void refreshMarkets(markets, {
      signal: controller.signal,
      onStatus: (message) => {
        if (alive) setListStatus(message);
      },
      onMarkets: (next) => {
        if (!alive) return;
        setMarkets(next);
        saveCachedMarkets(next);
        setListLoading(false);
      },
    })
      .then((result) => {
        if (!alive) return;
        setMarkets(result.markets);
        saveCachedMarkets(result.markets);
        setSource(result.source);
        setNotice(result.notice);
        setListError(result.error);
      })
      .catch((error: unknown) => {
        if (!alive || controller.signal.aborted) return;
        setListError(explainError(error));
      })
      .finally(() => {
        if (!alive) return;
        window.clearTimeout(budget);
        setListLoading(false);
        setListStatus(null);
      });
    return () => {
      alive = false;
      controller.abort();
      window.clearTimeout(budget);
    };
    // Reload is explicit. The in-flight refresh owns the list it started from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

  useEffect(() => {
    if (tokenIn && tokenOut) return;
    const market = preferredMarket(markets);
    if (!market) return;
    setTokenIn(market.quoteToken);
    setTokenOut(market.token);
  }, [markets, tokenIn, tokenOut]);

  const tokens = useMemo(() => tokenChoices(markets), [markets]);
  const payToken = tokens.find((token) => token.address === tokenIn) ?? null;
  const receiveToken = tokens.find((token) => token.address === tokenOut) ?? null;
  const market = useMemo(
    () => (tokenIn && tokenOut ? findMarket(markets, tokenIn, tokenOut) : null),
    [markets, tokenIn, tokenOut],
  );

  useEffect(() => {
    if (market) warmRoute(market);
  }, [market]);

  const refreshBalances = useCallback(async () => {
    if (!account) {
      setEthBalance(null);
      setPayBalance(null);
      return;
    }
    const [eth, tokenBalance] = await Promise.all([
      readEthBalance(account),
      tokenIn ? readTokenBalance(account, tokenIn) : Promise.resolve(null),
    ]);
    setEthBalance(eth);
    setPayBalance(tokenBalance);
  }, [account, tokenIn]);

  useEffect(() => {
    void refreshBalances().catch(() => {
      setEthBalance(null);
      setPayBalance(null);
    });
  }, [refreshBalances]);

  useEffect(() => {
    const provider = getInjected();
    void readWallet()
      .then((wallet) => {
        if (!wallet) return;
        setAccount(wallet.address);
        setChainId(wallet.chainId);
      })
      .catch(() => undefined);
    if (!provider?.on) return;
    const onAccounts = (...args: unknown[]) => {
      const accounts = args[0];
      const next = Array.isArray(accounts) ? accounts[0] : null;
      setAccount(typeof next === "string" ? (next as Address) : null);
      if (!next) setChainId(null);
    };
    const onChain = (...args: unknown[]) => {
      const value = args[0];
      if (typeof value === "string") setChainId(Number.parseInt(value, 16));
    };
    provider.on("accountsChanged", onAccounts);
    provider.on("chainChanged", onChain);
    return () => {
      provider.removeListener?.("accountsChanged", onAccounts);
      provider.removeListener?.("chainChanged", onChain);
    };
  }, []);

  useEffect(() => {
    if (!tokenIn || !tokenOut || !market) {
      setQuote(null);
      setQuoteError(tokenIn && tokenOut && markets.length > 0 ? "These tokens do not share a launch market." : null);
      setQuoteLoading(false);
      return;
    }
    if (tokenIn.toLowerCase() === tokenOut.toLowerCase()) {
      setQuote(null);
      setQuoteError("Choose two different tokens.");
      setQuoteLoading(false);
      return;
    }
    const payDecimals =
      tokenIn.toLowerCase() === market.quoteToken.toLowerCase() ? market.quoteDecimals : market.decimals;
    const draft = amountDraft(amount, payDecimals);
    if (draft === "empty") {
      setQuote(null);
      setQuoteError(null);
      setQuoteLoading(false);
      return;
    }
    if (draft === "invalid") {
      setQuote(null);
      setQuoteError("Enter an amount that fits this token's decimals.");
      setQuoteLoading(false);
      return;
    }
    if (draft === "partial") {
      setQuoteError(null);
      setQuoteLoading(true);
      return;
    }
    const parsed = parseAmount(amount, payDecimals);
    if (!parsed) return;

    let debounce = 0;
    let kill = 0;
    let interval = 0;
    const run = () => {
      window.clearTimeout(kill);
      const id = ++requestId.current;
      setQuoteLoading(true);
      setQuoteError(null);
      kill = window.setTimeout(() => {
        if (id !== requestId.current) return;
        setQuote(null);
        setQuoteError("The quote timed out. Try the amount again.");
        setQuoteLoading(false);
      }, 12_000);
      void quoteMarket({
        market,
        tokenIn,
        tokenOut,
        amountIn: parsed,
        slippageBps,
      })
        .then((next) => {
          if (id !== requestId.current) return;
          if (next.amountIn !== parsed || next.slippageBps !== slippageBps) return;
          window.clearTimeout(kill);
          setQuote(next);
          setQuoteError(null);
          setQuoteLoading(false);
        })
        .catch((error: unknown) => {
          if (id !== requestId.current) return;
          window.clearTimeout(kill);
          setQuote(null);
          setQuoteError(explainError(error));
          setQuoteLoading(false);
        });
    };
    debounce = window.setTimeout(run, 280);
    interval = window.setInterval(run, 15_000);
    return () => {
      window.clearTimeout(debounce);
      window.clearTimeout(kill);
      window.clearInterval(interval);
      requestId.current += 1;
    };
  }, [amount, market?.decimals, market?.model, market?.quoteDecimals, market?.status, market?.tradablePool, slippageBps, tokenIn, tokenOut]);

  useEffect(() => {
    if (!account || !quote) {
      setNeedsApproval(false);
      return;
    }
    let cancelled = false;
    void approvalStillNeeded(account, quote.approvals)
      .then((needed) => {
        if (!cancelled) setNeedsApproval(needed);
      })
      .catch(() => {
        if (!cancelled) setNeedsApproval(quote.approvals.length > 0);
      });
    return () => {
      cancelled = true;
    };
  }, [account, quote]);

  const wrongNetwork = account !== null && chainId !== GIWA_CHAIN_ID;
  const parsedAmount = payToken ? parseAmount(amount, payToken.decimals) : null;
  const quoteCurrent =
    quote &&
    parsedAmount &&
    tokenIn &&
    tokenOut &&
    quote.amountIn === parsedAmount &&
    quote.slippageBps === slippageBps &&
    quote.tokenIn.toLowerCase() === tokenIn.toLowerCase() &&
    quote.tokenOut.toLowerCase() === tokenOut.toLowerCase()
      ? quote
      : null;
  const insufficient =
    payBalance !== null && parsedAmount !== null && payBalance < parsedAmount;
  const swapping = phase === "preparing" || phase === "approving" || phase === "swapping";

  let buttonLabel = "Connect wallet";
  if (account && wrongNetwork) buttonLabel = "Switch to GIWA Sepolia";
  else if (account && !parsedAmount) buttonLabel = "Enter an amount";
  else if (account && quoteError) buttonLabel = "No route";
  else if (account && quoteLoading && !quoteCurrent) buttonLabel = "Quoting…";
  else if (account && insufficient) buttonLabel = "Insufficient balance";
  else if (account && phase === "approving") buttonLabel = "Approve in wallet…";
  else if (account && phase === "swapping") buttonLabel = "Confirm swap…";
  else if (account && phase === "preparing") buttonLabel = "Preparing…";
  else if (account && needsApproval) buttonLabel = `Approve ${payToken?.symbol ?? "token"} and swap`;
  else if (account) buttonLabel = "Swap";

  const buttonDisabled =
    swapping ||
    (account !== null &&
      !wrongNetwork &&
      (!parsedAmount || Boolean(quoteError) || insufficient || !quoteCurrent));

  async function onConnect() {
    setWalletBusy(true);
    setWalletNote(null);
    try {
      const wallet = await connectWallet();
      setAccount(wallet.address);
      setChainId(wallet.chainId);
      if (wallet.chainId !== GIWA_CHAIN_ID) {
        const next = await switchToGiwa();
        setChainId(next);
      }
    } catch (error) {
      setWalletNote(explainError(error));
    } finally {
      setWalletBusy(false);
    }
  }

  async function onSwitch() {
    setWalletBusy(true);
    setWalletNote(null);
    try {
      setChainId(await switchToGiwa());
    } catch (error) {
      setWalletNote(explainError(error));
    } finally {
      setWalletBusy(false);
    }
  }

  async function onAction() {
    if (!account) {
      await onConnect();
      return;
    }
    if (wrongNetwork) {
      await onSwitch();
      return;
    }
    if (!quoteCurrent || !parsedAmount) return;
    setSwapError(null);
    setReceipt(null);
    setPhase("preparing");
    try {
      const result = await executeQuotedSwap({
        quote: quoteCurrent,
        account,
        wallet: walletClientFor(account),
        slippageBps,
        onPhase: setPhase,
      });
      setReceipt({ hash: result.hash, approvalHashes: result.approvalHashes });
      setPhase("done");
      await refreshBalances();
    } catch (error) {
      setPhase("idle");
      setSwapError(explainError(error));
    }
  }

  const outputLabel = quoteCurrent && receiveToken
    ? formatAmount(quoteCurrent.expectedAmountOut, receiveToken.decimals)
    : quoteLoading
      ? "…"
      : "—";
  const minOutLabel = quoteCurrent && receiveToken
    ? `${formatAmount(quoteCurrent.minimumAmountOut, receiveToken.decimals)} ${receiveToken.symbol}`
    : null;
  const feeLabel = quoteCurrent
    ? quoteCurrent.feeAmount === null
      ? "Included in the route"
      : `${formatAmount(quoteCurrent.feeAmount, feeDecimals(quoteCurrent, tokens))} ${feeSymbol(quoteCurrent, tokens)}`
    : "";

  return (
    <div className="page">
      <Header
        connected={account !== null}
        address={account}
        chainId={chainId}
        ethLabel={ethBalance === null ? null : formatEth(ethBalance)}
        busy={walletBusy}
        onConnect={() => void onConnect()}
        onSwitch={() => void onSwitch()}
      />
      <main>
        <SwapCard
          tokens={tokens}
          tokenIn={tokenIn}
          tokenOut={tokenOut}
          amount={amount}
          onAmount={(value) => {
            setAmount(value);
            setPhase("idle");
            setReceipt(null);
            setSwapError(null);
          }}
          onPick={(side, address) => {
            if (side === "in") setTokenIn(address);
            else setTokenOut(address);
            setPhase("idle");
            setReceipt(null);
            setSwapError(null);
          }}
          onFlip={() => {
            setTokenIn(tokenOut);
            setTokenOut(tokenIn);
            setPhase("idle");
            setReceipt(null);
          }}
          slippageBps={slippageBps}
          onSlippage={setSlippageBps}
          balanceLabel={
            payBalance !== null && payToken ? `${formatAmount(payBalance, payToken.decimals)} ${payToken.symbol}` : null
          }
          outputLabel={outputLabel}
          minOutLabel={minOutLabel}
          quoteLoading={quoteLoading}
          quoteError={quoteError}
          details={
            quoteCurrent
              ? {
                  model: quoteCurrent.model.toUpperCase(),
                  pool: quoteCurrent.pool,
                  block: quoteCurrent.quoteBlockNumber.toLocaleString("en-US"),
                  impact: quoteCurrent.priceImpactBps === null ? "—" : formatBps(Number(quoteCurrent.priceImpactBps)),
                  fee: feeLabel,
                  approval: !account
                    ? quoteCurrent.approvals.length === 0
                      ? "Not required"
                      : "Your wallet approves this if it is needed"
                    : needsApproval && quoteCurrent.approvals[0]
                      ? `${payToken?.symbol ?? "Token"} → ${shortAddress(quoteCurrent.approvals[0].spender)}`
                      : quoteCurrent.approvals.length === 0
                        ? "Not required"
                        : "Already approved",
                  expiresAtMs: quoteCurrent.expiresAtMs,
                }
              : null
          }
          buttonLabel={buttonLabel}
          buttonDisabled={buttonDisabled}
          onAction={() => void onAction()}
          note={
            swapError ??
            walletNote ??
            (quoteCurrent
              ? `Quote expires in 30 seconds and refreshes automatically. SDK deadline is 20 minutes. Deployment ${deployment.slot}.`
              : null)
          }
          receipt={receipt}
        />
        <MarketList
          markets={markets}
          loading={listLoading}
          status={listStatus}
          notice={notice}
          error={listError}
          source={source}
          selected={tokenOut}
          onSelect={(market) => {
            setTokenIn(market.quoteToken);
            setTokenOut(market.token);
            setPhase("idle");
            setReceipt(null);
            setSwapError(null);
          }}
          onRetry={() => setReloadKey((key) => key + 1)}
        />
      </main>
      <Footer />
    </div>
  );
}

function tokenChoices(markets: Market[]): TokenChoice[] {
  const map = new Map<string, TokenChoice>();
  for (const market of markets) {
    map.set(market.quoteToken.toLowerCase(), {
      address: market.quoteToken,
      symbol: market.quoteSymbol,
      name: market.quoteName,
      decimals: market.quoteDecimals,
    });
  }
  for (const market of markets) {
    map.set(market.token.toLowerCase(), {
      address: market.token,
      symbol: market.symbol,
      name: market.name,
      decimals: market.decimals,
    });
  }
  return [...map.values()];
}

function feeDecimals(quote: QuoteView, tokens: TokenChoice[]): number {
  return tokens.find((token) => token.address.toLowerCase() === quote.feeToken?.toLowerCase())?.decimals ?? 18;
}

function feeSymbol(quote: QuoteView, tokens: TokenChoice[]): string {
  return tokens.find((token) => token.address.toLowerCase() === quote.feeToken?.toLowerCase())?.symbol ?? "fee";
}
