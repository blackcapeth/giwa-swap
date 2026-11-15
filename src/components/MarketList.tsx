import type { Address } from "viem";
import { formatUsd, hueFromAddress, shortAddress, statusLabel } from "../format";
import type { Market, MarketSource } from "../markets";

type MarketListProps = {
  markets: Market[];
  loading: boolean;
  status: string | null;
  notice: string | null;
  error: string | null;
  source: MarketSource | null;
  selected: Address | null;
  onSelect: (market: Market) => void;
  onRetry: () => void;
};

export function MarketList({
  markets,
  loading,
  status,
  notice,
  error,
  source,
  selected,
  onSelect,
  onRetry,
}: MarketListProps) {
  return (
    <section className="panel markets" aria-labelledby="markets-title">
      <div className="panel-head">
        <div>
          <h2 id="markets-title">Launches</h2>
          <p>
            {source === "data-api"
              ? "Live tokens from the Ammora data API."
              : source === "factory-logs"
                ? "Tokens discovered from the V4 factory while the indexer is down."
                : "Ammora launches on GIWA Sepolia."}
          </p>
        </div>
        <button type="button" className="text-button" onClick={onRetry} disabled={loading}>
          {loading ? "Loading" : "Refresh"}
        </button>
      </div>

      {notice ? <p className="banner">{notice}</p> : null}
      {error ? (
        <div className="empty">
          <h3>Launches could not be loaded</h3>
          <p>{error}</p>
          <button type="button" className="solid" onClick={onRetry}>
            Try again
          </button>
        </div>
      ) : null}

      {loading && markets.length === 0 ? (
        <div className="skeleton-list" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
        </div>
      ) : null}

      {!loading && !error && markets.length === 0 ? (
        <div className="empty">
          <h3>No launches yet</h3>
          <p>The indexer has no Ammora tokens for GIWA Sepolia. Refresh after a new launch is created.</p>
        </div>
      ) : null}

      {status && loading ? <p className="status-line">{status}</p> : null}

      <ul className="market-list">
        {markets.map((market) => {
          const price = formatUsd(market.priceUsd);
          const active = selected?.toLowerCase() === market.token.toLowerCase();
          return (
            <li key={market.token}>
              <button
                type="button"
                className={`market ${active ? "selected" : ""}`}
                onClick={() => onSelect(market)}
              >
                <span
                  className="avatar"
                  style={{ background: `hsl(${hueFromAddress(market.token)} 42% 28%)` }}
                >
                  {market.imageUrl ? <img src={market.imageUrl} alt="" /> : market.symbol.slice(0, 1)}
                </span>
                <span className="market-copy">
                  <strong>{market.symbol}</strong>
                  <em>
                    {market.name} · {shortAddress(market.token)}
                  </em>
                </span>
                <span className={`pill status-${market.status}`}>{statusLabel(market.status)}</span>
                <span className="price">{price ?? "Price unavailable"}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
