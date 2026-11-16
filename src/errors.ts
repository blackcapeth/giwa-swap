import { AmmoraDataApiError, AmmoraSdkError } from "@ammora-protocol/sdk";

export function explainError(error: unknown): string {
  if (isRejected(error)) return "The wallet closed the request.";
  if (error instanceof AmmoraDataApiError) {
    return error.status === 0 ? "the data API could not be reached" : `HTTP ${error.status}`;
  }
  if (error instanceof AmmoraSdkError) {
    if (error.code === "AMMORA_SDK_ROUTE_UNAVAILABLE") {
      return "No route for this pair on the auto-route deployment.";
    }
    if (error.code === "AMMORA_SDK_MIGRATION_READY") {
      return "This curve is ready to migrate. Trading resumes after the graduated pool is created.";
    }
    if (error.code === "ARLORA_CONTRACT_SLIPPAGE_EXCEEDED" || /PriceRangeViolation/i.test(error.message)) {
      return "This amount does not fit the pool's price range. Try a smaller size.";
    }
    if (error.code === "AMMORA_SDK_RPC_UNAVAILABLE") {
      return "GIWA Sepolia RPC could not complete the quote. Try again in a moment.";
    }
    return trim(error.message);
  }
  if (error instanceof Error) {
    if (/429|rate limit|over rate/i.test(error.message)) {
      return "GIWA Sepolia RPC is rate limiting requests. Wait a moment and refresh.";
    }
    if (/quote timed out/i.test(error.message)) return "The quote timed out. Try the amount again.";
    if (/timed out|aborted/i.test(error.message)) return "timed out";
    if (/failed to fetch|networkerror|load failed/i.test(error.message)) {
      return "The network request failed. Check the connection and try again.";
    }
    if (/PriceRangeViolation/i.test(error.message)) {
      return "This amount does not fit the pool's price range. Try a smaller size.";
    }
    return trim(error.message);
  }
  return "Something went wrong.";
}

function trim(message: string): string {
  const clean = message.replace(/\s+/g, " ").trim();
  return clean.length > 240 ? `${clean.slice(0, 237)}…` : clean;
}

function isRejected(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { name?: string; code?: number; cause?: unknown };
  if (value.name === "UserRejectedRequestError" || value.code === 4001) return true;
  return isRejected(value.cause);
}
