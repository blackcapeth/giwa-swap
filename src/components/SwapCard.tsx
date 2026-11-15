import { useEffect, useId, useState } from "react";
import type { Address } from "viem";
import { explorerAddress, explorerTx } from "../chain";
import { formatBps, hueFromAddress, shortAddress } from "../format";

export type TokenChoice = {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
};

type QuoteDetails = {
  model: string;
  pool: Address;
  block: string;
  impact: string;
  fee: string;
  approval: string | null;
  expiresAtMs: number;
};

type SwapCardProps = {
  tokens: TokenChoice[];
  tokenIn: Address | null;
  tokenOut: Address | null;
  amount: string;
  onAmount: (value: string) => void;
  onPick: (side: "in" | "out", address: Address) => void;
  onFlip: () => void;
  slippageBps: number;
  onSlippage: (bps: number) => void;
  balanceLabel: string | null;
  outputLabel: string;
  minOutLabel: string | null;
  quoteLoading: boolean;
  quoteError: string | null;
  details: QuoteDetails | null;
  buttonLabel: string;
  buttonDisabled: boolean;
  onAction: () => void;
  note: string | null;
  receipt: { hash: string; approvalHashes: readonly string[] } | null;
};

const PRESETS = [10, 50, 100];

export function SwapCard(props: SwapCardProps) {
  const [picker, setPicker] = useState<"in" | "out" | null>(null);
  const [slippageOpen, setSlippageOpen] = useState(false);
  const [customSlippage, setCustomSlippage] = useState("");
  const slippageId = useId();
  const tokenIn = props.tokens.find((token) => token.address === props.tokenIn) ?? null;
  const tokenOut = props.tokens.find((token) => token.address === props.tokenOut) ?? null;

  useEffect(() => {
    if (!picker) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPicker(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [picker]);

  return (
    <section className="panel swap" aria-labelledby="swap-title">
      <div className="panel-head">
        <div>
          <h2 id="swap-title">Swap</h2>
          <p>Exact input. The SDK quotes the minimum you will receive.</p>
        </div>
        <div className="slippage">
          <button
            type="button"
            className="text-button"
            aria-expanded={slippageOpen}
            aria-controls={slippageId}
            onClick={() => setSlippageOpen((open) => !open)}
          >
            Slippage {formatBps(props.slippageBps)}
          </button>
          {slippageOpen ? (
            <div className="slippage-panel" id={slippageId}>
              {PRESETS.map((bps) => (
                <button
                  key={bps}
                  type="button"
                  className={props.slippageBps === bps ? "chip on" : "chip"}
                  onClick={() => {
                    props.onSlippage(bps);
                    setCustomSlippage("");
                  }}
                >
                  {formatBps(bps)}
                </button>
              ))}
              <label>
                Custom
                <input
                  inputMode="decimal"
                  value={customSlippage}
                  placeholder="0.30"
                  onChange={(event) => {
                    const next = event.target.value;
                    setCustomSlippage(next);
                    const parsed = Number(next);
                    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 5) {
                      props.onSlippage(Math.round(parsed * 100));
                    }
                  }}
                />
              </label>
            </div>
          ) : null}
        </div>
      </div>

      <div className="field">
        <div className="field-label">
          <span>You pay</span>
          <span>{props.balanceLabel ? `Balance ${props.balanceLabel}` : "Balance —"}</span>
        </div>
        <div className="field-row">
          <input
            inputMode="decimal"
            aria-label="Amount to pay"
            placeholder="0.0"
            value={props.amount}
            onChange={(event) => props.onAmount(sanitizeAmount(event.target.value))}
          />
          <TokenButton token={tokenIn} onClick={() => setPicker("in")} />
        </div>
      </div>

      <button type="button" className="flip" onClick={props.onFlip} aria-label="Flip tokens">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M7 8h10M14 5l3 3-3 3M17 16H7M10 13l-3 3 3 3" />
        </svg>
      </button>

      <div className="field receive">
        <div className="field-label">
          <span>You receive</span>
          <span>{props.quoteLoading ? "Quoting…" : "Estimated"}</span>
        </div>
        <div className="field-row">
          <output className={props.quoteLoading ? "loading" : ""}>{props.outputLabel}</output>
          <TokenButton token={tokenOut} onClick={() => setPicker("out")} />
        </div>
      </div>

      {props.quoteError ? <p className="alert">{props.quoteError}</p> : null}

      {props.details ? (
        <dl className="details">
          <div>
            <dt>Minimum received</dt>
            <dd>{props.minOutLabel}</dd>
          </div>
          <div>
            <dt>Price impact</dt>
            <dd>{props.details.impact}</dd>
          </div>
          <div>
            <dt>Fee</dt>
            <dd>{props.details.fee}</dd>
          </div>
          <div>
            <dt>Route</dt>
            <dd>
              {props.details.model} · block {props.details.block}
            </dd>
          </div>
          <div>
            <dt>Pool</dt>
            <dd>
              <a href={explorerAddress(props.details.pool)} rel="noreferrer">
                {shortAddress(props.details.pool)}
              </a>
            </dd>
          </div>
          {props.details.approval ? (
            <div>
              <dt>Approval</dt>
              <dd>{props.details.approval}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}

      <button type="button" className="submit" disabled={props.buttonDisabled} onClick={props.onAction}>
        {props.buttonLabel}
      </button>
      {props.note ? <p className="note">{props.note}</p> : null}
      {props.receipt ? (
        <p className="receipt">
          Swap submitted.{" "}
          <a href={explorerTx(props.receipt.hash)} rel="noreferrer">
            View receipt
          </a>
          {props.receipt.approvalHashes.length > 0 ? (
            <>
              {" "}
              ·{" "}
              <a href={explorerTx(props.receipt.approvalHashes[0] ?? "")} rel="noreferrer">
                Approval
              </a>
            </>
          ) : null}
        </p>
      ) : null}

      {picker ? (
        <div className="modal-backdrop" onClick={() => setPicker(null)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label={picker === "in" ? "Choose token to pay" : "Choose token to receive"}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-head">
              <h3>{picker === "in" ? "Pay with" : "Receive"}</h3>
              <button type="button" className="text-button" onClick={() => setPicker(null)}>
                Close
              </button>
            </div>
            {props.tokens.length === 0 ? (
              <p className="empty-inline">No tokens yet. Launches will show up here.</p>
            ) : (
              <ul>
                {props.tokens.map((token) => (
                  <li key={token.address}>
                    <button
                      type="button"
                      onClick={() => {
                        props.onPick(picker, token.address);
                        setPicker(null);
                      }}
                    >
                      <span
                        className="avatar"
                        style={{ background: `hsl(${hueFromAddress(token.address)} 42% 28%)` }}
                      >
                        {token.symbol.slice(0, 1)}
                      </span>
                      <span>
                        <strong>{token.symbol}</strong>
                        <em>{token.name}</em>
                      </span>
                      <code>{shortAddress(token.address)}</code>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function TokenButton({ token, onClick }: { token: TokenChoice | null; onClick: () => void }) {
  return (
    <button type="button" className="token" onClick={onClick}>
      <span
        className="avatar small"
        style={token ? { background: `hsl(${hueFromAddress(token.address)} 42% 28%)` } : undefined}
      >
        {token ? token.symbol.slice(0, 1) : "?"}
      </span>
      {token ? token.symbol : "Select"}
    </button>
  );
}

function sanitizeAmount(value: string): string {
  const cleaned = value.replace(/[^\d.]/g, "");
  const [whole, ...rest] = cleaned.split(".");
  if (rest.length === 0) return whole;
  return `${whole}.${rest.join("").slice(0, 18)}`;
}
