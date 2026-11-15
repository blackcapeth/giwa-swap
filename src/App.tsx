import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Address } from "viem";
import { GIWA_CHAIN_ID, deployment } from "./chain";
import { Footer } from "./components/Footer";
import { Header } from "./components/Header";
import { MarketList } from "./components/MarketList";
import { SwapCard, type TokenChoice } from "./components/SwapCard";
import { explainError } from "./errors";
import { formatAmount, formatBps, parseAmount, shortAddress } from "./format";
import { discoverMarkets, type Market, type MarketSource } from "./markets";
import { approvalStillNeeded, executeQuotedSwap, findMarket, quoteMarket, type QuoteView } from "./trading";
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

export function App() {
  const [markets, setMarkets] = useState<Market[]>([]);
  const [source, setSource] = useState<MarketSource | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [listStatus, setListStatus] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(true);

  const [tokenIn, setTokenIn] = useState<Address | null>(null);
  const [tokenOut, setTokenOut] = useState<Address | null>(null);
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
  const initialized = useRef(false);

  const loadMarkets = useCallback(async () => {
    setListLoading(true);
    setListError(null);
    setListStatus("Checking the Ammora data API…");
    try {
      const result = await discoverMarkets(setListStatus);
      setMarkets(result.markets);
      setSource(result.source);
      setNotice(result.notice);
      setListStatus(null);
    } catch (error) {
      setMarkets([]);
      setSource(null);
      setNotice(null);
      setListError(explainError(error));
      setListStatus(null);
    } finally {
      setListLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadMarkets();
  }, [loadMarkets]);

  useEffect(() => {
    if (initialized.current || markets.length === 0) return;
    const market = markets.find((item) => item.status === 1) ?? markets[0];
    if (!market) return;
    initialized.current = true;
    setTokenIn(market.quoteToken);
    setTokenOut(market.token);
  }, [markets]);

  const tokens = useMemo(() => tokenChoices(markets), [markets]);
  const payToken = tokens.find((token) => token.address === tokenIn) ?? null;
  const receiveToken = tokens.find((token) => token.address === tokenOut) ?? null;

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
    if (!tokenIn || !tokenOut || markets.length === 0) {
      setQuote(null);
      setQuoteError(null);
      setQuoteLoading(false);
      return;
    }
    if (tokenIn.toLowerCase() === tokenOut.toLowerCase()) {
      setQuote(null);
      setQuoteError("Choose two different tokens.");
      setQuoteLoading(false);
      return;
    }
    const pay = tokens.find((token) => token.address === tokenIn);
    if (!pay) return;
    const parsed = parseAmount(amount, pay.decimals);
    if (!parsed) {
      setQuote(null);
      setQuoteError(amount.trim() ? "Enter an amount that fits this token's decimals." : null);
      setQuoteLoading(false);
      return;
    }
    const market = findMarket(markets, tokenIn, tokenOut);
    if (!market) {
      setQuote(null);
      setQuoteError("These tokens do not share a launch market.");
      setQuoteLoading(false);
      return;
    }

    let timer = 0;
    let interval = 0;
    const run = () => {
      const id = ++requestId.current;
      setQuoteLoading(true);
      void quoteMarket({
        market,
        tokenIn,
        tokenOut,
        amountIn: parsed,
        slippageBps,
      })
        .then((next) => {
          if (id !== requestId.current) return;
          setQuote(next);
          setQuoteError(null);
        })
        .catch((error: unknown) => {
          if (id !== requestId.current) return;
          setQuote(null);
          setQuoteError(explainError(error));
        })
        .finally(() => {
          if (id === requestId.current) setQuoteLoading(false);
        });
    };
    timer = window.setTimeout(run, 280);
    interval = window.setInterval(run, 15_000);
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(interval);
      requestId.current += 1;
    };
  }, [amount, listLoading, markets, slippageBps, tokenIn, tokenOut, tokens]);

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
  const insufficient =
    payBalance !== null && parsedAmount !== null && payBalance < parsedAmount;
  const swapping = phase === "preparing" || phase === "approving" || phase === "swapping";

  let buttonLabel = "Connect wallet";
  if (account && wrongNetwork) buttonLabel = "Switch to GIWA Sepolia";
  else if (account && !parsedAmount) buttonLabel = "Enter an amount";
  else if (account && quoteError) buttonLabel = "No route";
  else if (account && quoteLoading && !quote) buttonLabel = "Quoting…";
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
      (!parsedAmount || Boolean(quoteError) || insufficient || (quoteLoading && !quote) || !quote));

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
    if (!quote || !parsedAmount) return;
    setSwapError(null);
    setReceipt(null);
    setPhase("preparing");
    try {
      const result = await executeQuotedSwap({
        quote,
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

  const outputLabel = quote && receiveToken
    ? formatAmount(quote.expectedAmountOut, receiveToken.decimals)
    : quoteLoading
      ? "…"
      : "—";
  const minOutLabel = quote && receiveToken
    ? `${formatAmount(quote.minimumAmountOut, receiveToken.decimals)} ${receiveToken.symbol}`
    : null;
  const feeLabel = quote
    ? quote.feeAmount === null
      ? "Included in the route"
      : `${formatAmount(quote.feeAmount, feeDecimals(quote, tokens))} ${feeSymbol(quote, tokens)}`
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
            quote
              ? {
                  model: quote.model.toUpperCase(),
                  pool: quote.pool,
                  block: quote.quoteBlockNumber.toLocaleString("en-US"),
                  impact: quote.priceImpactBps === null ? "—" : formatBps(Number(quote.priceImpactBps)),
                  fee: feeLabel,
                  approval: !account
                    ? quote.approvals.length === 0
                      ? "Not required"
                      : "Your wallet approves this if it is needed"
                    : needsApproval && quote.approvals[0]
                      ? `${payToken?.symbol ?? "Token"} → ${shortAddress(quote.approvals[0].spender)}`
                      : quote.approvals.length === 0
                        ? "Not required"
                        : "Already approved",
                  expiresAtMs: quote.expiresAtMs,
                }
              : null
          }
          buttonLabel={buttonLabel}
          buttonDisabled={buttonDisabled}
          onAction={() => void onAction()}
          note={
            swapError ??
            walletNote ??
            (quote
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
          onRetry={() => void loadMarkets()}
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
