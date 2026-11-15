import { createWalletClient, custom, erc20Abi, formatEther, numberToHex, type Address, type WalletClient } from "viem";
import { GIWA_CHAIN_ID, GIWA_EXPLORER_URL, GIWA_RPC_URL, giwaChain, publicClient } from "./chain";

export type InjectedProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
};

export function getInjected(): InjectedProvider | null {
  if (typeof window === "undefined") return null;
  const provider = (window as Window & { ethereum?: InjectedProvider }).ethereum;
  return provider ?? null;
}

export async function connectWallet(): Promise<{ address: Address; chainId: number }> {
  const provider = getInjected();
  if (!provider) {
    throw new Error("No injected wallet found. Install MetaMask or another browser wallet.");
  }
  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
  const account = accounts[0];
  if (!account) throw new Error("The wallet did not return an account.");
  const chainId = await readChainId(provider);
  return { address: account as Address, chainId };
}

export async function readWallet(): Promise<{ address: Address; chainId: number } | null> {
  const provider = getInjected();
  if (!provider) return null;
  const accounts = (await provider.request({ method: "eth_accounts" })) as string[];
  const account = accounts[0];
  if (!account) return null;
  return { address: account as Address, chainId: await readChainId(provider) };
}

export async function switchToGiwa(): Promise<number> {
  const provider = getInjected();
  if (!provider) {
    throw new Error("No injected wallet found. Install MetaMask or another browser wallet.");
  }
  const chainIdHex = numberToHex(GIWA_CHAIN_ID);
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: chainIdHex }],
    });
  } catch (error) {
    const code = (error as { code?: number }).code;
    if (code !== 4902 && code !== -32603) throw error;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: chainIdHex,
          chainName: giwaChain.name,
          nativeCurrency: giwaChain.nativeCurrency,
          rpcUrls: [GIWA_RPC_URL],
          blockExplorerUrls: [GIWA_EXPLORER_URL],
        },
      ],
    });
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: chainIdHex }],
    });
  }
  return readChainId(provider);
}

export function walletClientFor(account: Address): WalletClient {
  const provider = getInjected();
  if (!provider) throw new Error("No injected wallet found.");
  return createWalletClient({
    account,
    chain: giwaChain,
    transport: custom(provider),
  });
}

export async function readEthBalance(account: Address): Promise<bigint> {
  return publicClient.getBalance({ address: account });
}

export async function readTokenBalance(account: Address, token: Address): Promise<bigint> {
  return publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account],
  });
}

export function formatEth(value: bigint): string {
  const text = formatEther(value);
  const [whole, fraction = ""] = text.split(".");
  const trimmed = fraction.slice(0, 4).replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole;
}

async function readChainId(provider: InjectedProvider): Promise<number> {
  const value = await provider.request({ method: "eth_chainId" });
  if (typeof value !== "string") throw new Error("The wallet returned an unexpected chain id.");
  return Number.parseInt(value, 16);
}
