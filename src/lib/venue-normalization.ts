import { EquityOrderInput } from "./types";
import { audit } from "./db";
import { roundAlpacaPrice, roundCents } from "./money";

export function normalizeVenueOrder(input: EquityOrderInput, broker: string, userId: string): EquityOrderInput {
  let { type, timeInForce, marketHours, limitPrice, stopPrice, quantity, dollarAmount, bracketTakeProfit, bracketStopLoss, bracketStopLimit } = input;
  let normalized = false;
  let reason = "";

  const isBracket = bracketTakeProfit != null || bracketStopLoss != null;
  const isFractionalQty = quantity != null && !Number.isInteger(quantity);
  const isNotional = dollarAmount != null && dollarAmount > 0;
  const fractional = isFractionalQty || isNotional;

  if (broker === "alpaca") {
    // 1. Alpaca requires TIF=day for fractional, notional, bracket, or extended-hours.
    if (timeInForce === "gtc" || timeInForce === "gfd") {
      if (fractional || isBracket || marketHours === "extended_hours") {
        timeInForce = "day" as typeof timeInForce;
        normalized = true;
        reason = isBracket ? "bracket" : fractional ? "fractional" : "extended_hours";
      }
    }
    if (limitPrice != null) limitPrice = roundAlpacaPrice(limitPrice);
    if (stopPrice != null) stopPrice = roundAlpacaPrice(stopPrice);
    if (bracketTakeProfit != null) bracketTakeProfit = roundAlpacaPrice(bracketTakeProfit);
    if (bracketStopLoss != null) bracketStopLoss = roundAlpacaPrice(bracketStopLoss);
    if (bracketStopLimit != null) bracketStopLimit = roundAlpacaPrice(bracketStopLimit);

  } else if (broker === "robinhood") {
    // 2. Robinhood: silently converts a fractional or extended-hours limit into a regular-hours MARKET order
    // But we need to keep the audit.
    const isStop = type === "stop_market" || type === "stop_limit";
    const isOpening = input.side === "buy";
    // We also coerce extended-hours limits into regular-hours market if fractional. 
    // Wait, the prompt says "silently converts a fractional OR extended-hours limit into a regular-hours MARKET order"
    // So if it's fractional OR extended-hours?
    // Let's coerce both if opening, or if fractional. Robinhood doesn't support extended hours market, but it converts them.
    // If we just check `fractional || marketHours === "extended_hours"` ?
    const coerceToMarket = isOpening && (fractional || marketHours === "extended_hours") && !isStop;
    
    if (coerceToMarket) {
      if (type !== "market" || timeInForce !== "gfd" || marketHours !== "regular_hours") {
        type = "market" as typeof type;
        limitPrice = undefined;
        stopPrice = undefined;
        timeInForce = "gfd" as typeof timeInForce;
        marketHours = "regular_hours" as typeof marketHours;
        normalized = true;
        reason = fractional ? "robinhood_fractional_must_be_market" : "robinhood_extended_hours_must_be_market";
      }
    }
    
    if (limitPrice != null) limitPrice = roundCents(limitPrice);
    if (stopPrice != null) stopPrice = roundCents(stopPrice);
    if (bracketTakeProfit != null) bracketTakeProfit = roundCents(bracketTakeProfit);
    if (bracketStopLoss != null) bracketStopLoss = roundCents(bracketStopLoss);
    if (bracketStopLimit != null) bracketStopLimit = roundCents(bracketStopLimit);
    
  } else if (broker === "tradier") {
    // 3. Tradier: sends the unrounded limit price and always attaches a stop field
    // We round them here so the adapter receives rounded values.
    if (limitPrice != null) limitPrice = roundCents(limitPrice);
    if (stopPrice != null) stopPrice = roundCents(stopPrice);
    if (bracketTakeProfit != null) bracketTakeProfit = roundCents(bracketTakeProfit);
    if (bracketStopLoss != null) bracketStopLoss = roundCents(bracketStopLoss);
    if (bracketStopLimit != null) bracketStopLimit = roundCents(bracketStopLimit);
    
    if (type === "limit") stopPrice = undefined;
    if (type === "stop_market") limitPrice = undefined;
    if (type === "market") { limitPrice = undefined; stopPrice = undefined; }
  }

  if (normalized) {
    audit("venue_order_normalized", {
      broker,
      symbol: input.symbol,
      side: input.side,
      originalType: input.type,
      newType: type,
      originalTimeInForce: input.timeInForce,
      newTimeInForce: timeInForce,
      reason
    }, userId);
  }

  return {
    ...input,
    type,
    timeInForce,
    marketHours,
    limitPrice,
    stopPrice,
    bracketTakeProfit,
    bracketStopLoss,
    bracketStopLimit
  };
}
