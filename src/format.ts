import { parseUnits } from "viem";

export type AmountDraft = "empty" | "partial" | "invalid" | "ready";

/** Distinguish a half-typed amount from one that can be quoted. */
export function amountDraft(value: string, decimals: number): AmountDraft {
  const trimmed = value.trim();
  if (!trimmed) return "empty";
  if (!/^\d*\.?\d*$/.test(trimmed)) return "invalid";
  if (trimmed.endsWith(".")) return "partial";
  if (parseAmount(trimmed, decimals)) return "ready";
  if (/^0*\.?0*$/.test(trimmed)) return "partial";
  return "invalid";
}

export function parseAmount(value: string, decimals: number): bigint | null {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const fraction = trimmed.split(".")[1] ?? "";
  if (fraction.length > decimals) return null;
  try {
    const parsed = parseUnits(trimmed, decimals);
    return parsed > 0n ? parsed : null;
  } catch {
    return null;
  }
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function formatAmount(value: bigint, decimals: number): string {
  if (value === 0n) return "0";
  const negative = value < 0n;
  const raw = formatDecimal(negative ? -value : value, decimals);
  const [whole, fraction = ""] = raw.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const digits = whole === "0" ? 8 : 4;
  const trimmed = fraction.slice(0, digits).replace(/0+$/, "");
  const text = trimmed ? `${grouped}.${trimmed}` : grouped;
  return negative ? `-${text}` : text;
}

function formatDecimal(value: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = value % base;
  if (fraction === 0n) return whole.toString();
  return `${whole.toString()}.${fraction.toString().padStart(decimals, "0")}`;
}

export function formatUsd(value: number | null): string | null {
  if (value === null || !Number.isFinite(value) || value <= 0) return null;
  if (value >= 1) {
    return `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  }
  if (value >= 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toPrecision(3)}`;
}

export function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

export function statusLabel(status: number): string {
  switch (status) {
    case 1:
      return "Trading";
    case 2:
      return "Migrating";
    case 3:
      return "Graduated";
    case 0:
      return "Pending";
    default:
      return "Unknown";
  }
}

export function hueFromAddress(address: string): number {
  const slice = Number.parseInt(address.slice(2, 8), 16);
  return Number.isFinite(slice) ? slice % 360 : 150;
}
