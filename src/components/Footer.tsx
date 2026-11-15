export function Footer() {
  return (
    <footer className="site-footer">
      <p>
        Built with the{" "}
        <a href="https://www.npmjs.com/package/@ammora-protocol/sdk" rel="noreferrer">
          Ammora SDK
        </a>{" "}
        on{" "}
        <a href="https://ammora.org" rel="noreferrer">
          GIWA Sepolia
        </a>
      </p>
      <p className="fine">
        Testnet only. Quotes come from the SDK. Your wallet signs every approval and swap.
      </p>
    </footer>
  );
}
