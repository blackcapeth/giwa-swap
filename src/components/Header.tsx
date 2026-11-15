import { GIWA_CHAIN_ID } from "../chain";
import { shortAddress } from "../format";

type HeaderProps = {
  connected: boolean;
  address: string | null;
  chainId: number | null;
  ethLabel: string | null;
  busy: boolean;
  onConnect: () => void;
  onSwitch: () => void;
};

export function Header({
  connected,
  address,
  chainId,
  ethLabel,
  busy,
  onConnect,
  onSwitch,
}: HeaderProps) {
  const wrongNetwork = connected && chainId !== GIWA_CHAIN_ID;

  return (
    <header className="topbar">
      <div className="brand">
        <span className="mark" aria-hidden="true">
          <svg viewBox="0 0 32 32">
            <path d="M7 12h12M16 8l4 4-4 4" />
            <path d="M25 20H13M16 16l-4 4 4 4" />
          </svg>
        </span>
        <div>
          <p className="wordmark">
            GIWA <em>Swap</em>
          </p>
          <p className="eyebrow">Ammora auto-route · V4</p>
        </div>
      </div>
      <div className="top-actions">
        <p className={`net ${wrongNetwork ? "warn" : ""}`}>
          <span className="dot" />
          {wrongNetwork ? `Wallet on chain ${chainId}` : `GIWA Sepolia · ${GIWA_CHAIN_ID}`}
        </p>
        {connected && address ? (
          <button
            type="button"
            className="wallet"
            onClick={wrongNetwork ? onSwitch : undefined}
            disabled={busy || !wrongNetwork}
          >
            <span>{shortAddress(address)}</span>
            <strong>{ethLabel ? `${ethLabel} ETH` : "…"}</strong>
          </button>
        ) : (
          <button type="button" className="wallet primary" onClick={onConnect} disabled={busy}>
            {busy ? "Connecting…" : "Connect wallet"}
          </button>
        )}
      </div>
    </header>
  );
}
