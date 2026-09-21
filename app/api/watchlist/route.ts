import { getBrokerGateway } from "@/lib/broker";
import { getPolicy } from "@/lib/db";
import { normalizeSymbol } from "@/lib/money";
import { resolveRequestUserId } from "@/lib/request-user";
import { addToWatchlist, listWatchlist, removeFromWatchlist } from "@/lib/watchlist";
import { fetchFreshQuotesCascade } from "@/lib/quotes-cascade";
import type { BrokerQuote } from "@/lib/types";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const userId = resolveRequestUserId(request);
  const items = listWatchlist(userId);
  if (items.length === 0) {
    return NextResponse.json({ items, quotes: {} });
  }

  const policy = getPolicy(userId);
  const accountNumber = policy.accountNumber;
  const symbols = items.map((item) => item.symbol);
  let quotes: Record<string, BrokerQuote> = {};

  if (accountNumber && policy.activeBroker) {
    try {
      quotes = await getBrokerGateway(policy, userId).getEquityQuotes(accountNumber, symbols);
    } catch (err) {
      console.warn("[watchlist] broker getEquityQuotes failed, falling back to cascade:", err);
    }
  }

  const missing = symbols.filter(
    (s) => !quotes[s] || typeof quotes[s]?.price !== "number" || quotes[s]!.price! <= 0
  );
  if (missing.length > 0) {
    try {
      const fallback = await fetchFreshQuotesCascade(missing, userId, accountNumber ?? undefined);
      for (const s of missing) {
        if (fallback[s] && typeof fallback[s].price === "number" && fallback[s].price > 0) {
          quotes[s] = fallback[s];
        }
      }
    } catch (err) {
      console.warn("[watchlist] fetchFreshQuotesCascade fallback error:", err);
    }
  }

  return NextResponse.json({ items, quotes });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { symbol?: unknown; userId?: unknown };
  const userId = resolveRequestUserId(request, body);
  if (typeof body.symbol !== "string" || body.symbol.trim().length === 0) {
    return NextResponse.json({ error: "symbol is required" }, { status: 400 });
  }
  try {
    const item = addToWatchlist(userId, body.symbol);
    return NextResponse.json(item, { status: item.deduped ? 200 : 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "invalid symbol" }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  const url = new URL(request.url);
  const body = (await request.json().catch(() => ({}))) as { symbol?: unknown; userId?: unknown };
  const userId = resolveRequestUserId(request, body);
  const symbol = typeof body.symbol === "string" ? body.symbol : url.searchParams.get("symbol");
  if (!symbol) return NextResponse.json({ error: "symbol is required" }, { status: 400 });
  const removed = removeFromWatchlist(userId, normalizeSymbol(symbol));
  return NextResponse.json({ removed });
}
