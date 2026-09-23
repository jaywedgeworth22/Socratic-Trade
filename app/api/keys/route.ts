import { NextRequest, NextResponse } from "next/server";
import {
  apiKeyEnvVarForService,
  listUserApiKeys,
  LOCAL_USER,
  maskApiKeyPreview,
  normalizeApiKeyService,
  upsertUserApiKey,
  deleteUserApiKey,
  setUserApiKeyPlanTier,
  resolveApiKeyWithSource
} from "@/lib/db";
import { checkAdmin } from "@/lib/auth/admin";
import { resolveRequestUserId } from "@/lib/request-user";
import { queueStPrimaryBridgeWriterSync } from "@/lib/st-primary-bridge-writer";
import {
  defaultPlanTierForService,
  isRetiredMarketDataService,
  isValidPlanTierForService,
  planTierOptionsForService,
  servicesWithPlanTierUi
} from "@/lib/provider-tier-plan";

export const dynamic = "force-dynamic";

/**
 * Multi-user API Key Management
 *
 * Per-user API key storage. Identity comes from middleware's verified
 * `x-authenticated-user-email` header; request body/query user hints are ignored.
 *
 * Supported services are defined in API_KEY_CATALOG below.
 *
 * GET  /api/keys             → list all keys for the current user
 * GET  /api/keys?service=<s> → resolve key (user → env fallback)
 * POST /api/keys  { service, apiKey?, label?, planTier? }  → upsert key and/or plan tier
 * DELETE /api/keys?service=<s>  → delete key
 */

const API_KEY_CATALOG = [
  {
    service: "openai",
    label: "OpenAI",
    category: "LLM",
    required: false,
    unlocks: "OpenAI models for trade proposals, strategy reviews, red-team debate, and post-mortems.",
    docsUrl: "https://platform.openai.com/api-keys"
  },
  {
    service: "anthropic",
    label: "Anthropic (Claude)",
    category: "LLM",
    required: false,
    unlocks: "Claude models for the Assistant chat and for the Green/Red Team (trade proposals, strategy review, red-team debate). Select a claude-* model in Strategy or the Assistant to use.",
    docsUrl: "https://console.anthropic.com/settings/keys"
  },
  {
    service: "xai",
    label: "xAI (Grok)",
    category: "LLM",
    required: false,
    unlocks: "Grok models for trade proposals, strategy analysis, and the Assistant. Select a grok-* model to use.",
    docsUrl: "https://console.x.ai/"
  },
  {
    service: "gemini",
    label: "Google (Gemini)",
    category: "LLM",
    required: false,
    unlocks: "Gemini models for the Assistant and strategy review. Select a gemini-* model in the Assistant or Strategy screen to use.",
    docsUrl: "https://aistudio.google.com/app/apikey"
  },
  {
    service: "mistral",
    label: "Mistral AI",
    category: "LLM",
    required: false,
    unlocks: "Mistral models for the Assistant and strategy review. Select a mistral-* model in the Assistant or Strategy screen to use.",
    docsUrl: "https://console.mistral.ai/api-keys/"
  },
  {
    service: "deepseek",
    label: "DeepSeek",
    category: "LLM",
    required: false,
    unlocks: "DeepSeek V4 models (deepseek-v4-flash / deepseek-v4-pro) for the Assistant and strategy. Note: requests are processed on DeepSeek's servers (China).",
    docsUrl: "https://platform.deepseek.com/api_keys"
  },
  {
    service: "moonshot",
    label: "Moonshot AI (Kimi)",
    category: "LLM",
    required: false,
    unlocks: "Moonshot AI / Kimi models (kimi-latest) for the Assistant and strategy.",
    docsUrl: "https://platform.moonshot.cn/console/api-keys"
  },
  {
    service: "minimax",
    label: "MiniMax",
    category: "LLM",
    required: false,
    unlocks: "MiniMax models for the Assistant and strategy using a pay-as-you-go API key.",
    docsUrl: "https://platform.minimax.io/user-center/basic-information/interface-key"
  },
  {
    service: "openrouter",
    label: "OpenRouter",
    category: "LLM",
    required: false,
    unlocks: "Access to OpenRouter models including DeepSeek and Qwen for the Assistant and strategy.",
    docsUrl: "https://openrouter.ai/keys"
  },
  {
    service: "finnhub",
    label: "Finnhub",
    category: "Market data",
    required: false,
    unlocks: "News sentiment, analyst recommendations, company profile, and financial metrics.",
    docsUrl: "https://finnhub.io/dashboard"
  },
  {
    service: "fmp",
    label: "Financial Modeling Prep",
    category: "Market data",
    required: false,
    unlocks: "Retired on Socratic-Trade — CT-only. Do not use for ST product enrichment.",
    docsUrl: "https://site.financialmodelingprep.com/developer/docs",
    retired: true,
    retiredNote: "Retired on Socratic-Trade (Congress.Trade only). Key row kept for archaeology; product code never calls FMP."
  },
  {
    service: "alphavantage",
    label: "Alpha Vantage",
    category: "Market data",
    required: false,
    unlocks: "Supplemental fundamentals and sentiment where the keyed quota is available.",
    docsUrl: "https://www.alphavantage.co/support/#api-key"
  },
  {
    service: "marketstack",
    label: "Marketstack",
    category: "Price history",
    required: false,
    unlocks: "Reliable daily OHLC fallback for price charts and computed technicals.",
    docsUrl: "https://marketstack.com/signup/free"
  },
  {
    service: "fred",
    label: "FRED",
    category: "Macro",
    required: false,
    unlocks: "Rates, inflation, growth, credit spreads, VIX, and Macro tab sparklines.",
    docsUrl: "https://fred.stlouisfed.org/docs/api/api_key.html"
  },
  {
    service: "sec_edgar_user_agent",
    label: "SEC EDGAR User-Agent",
    category: "Scrapers",
    required: false,
    credentialName: "contact",
    unlocks: "Polite SEC Form 4 and 8-K requests with your descriptive contact string.",
    docsUrl: "https://www.sec.gov/os/accessing-edgar-data"
  },
  {
    service: "massive",
    label: "Massive",
    category: "Market-wide signals",
    required: false,
    unlocks: "Full-market breadth, broad liquid movers, news, and keyed price-history primary data.",
    docsUrl: "https://massive.com"
  },
  {
    service: "tiingo",
    label: "Tiingo",
    category: "Market data",
    required: false,
    unlocks: "Cross-asset price history, fundamentals, IEX top-of-book quotes, and news sentiment.",
    docsUrl: "https://api.tiingo.com/"
  },
  {
    service: "twelvedata",
    label: "Twelve Data",
    category: "Market data",
    required: false,
    unlocks: "Real-time and intraday price feeds, forex, crypto, and technical indicators.",
    docsUrl: "https://twelvedata.com/account/api-keys"
  },
  {
    service: "roic",
    label: "ROIC.ai",
    category: "Market data",
    required: false,
    unlocks:
      "Deep fundamentals, ratios, price history, and full earnings-call transcripts (RAG). Paste your key and set plan tier (Free vs Individual/Professional) so daily quotas match what you pay for.",
    docsUrl: "https://www.roic.ai/api"
  },
  {
    service: "filingapi",
    label: "FilingAPI",
    category: "Market data",
    required: false,
    unlocks:
      "Optional. Sector/industry, earnings calendar proximity, and insider-sentiment summaries. Missing or 401 keys skip this lane; ROIC and SEC EDGAR cover the same class. Do not buy Plus here.",
    docsUrl: "https://filingapi.dev"
  },
  {
    service: "marketaux",
    label: "MarketAux",
    category: "Market sentiment",
    required: false,
    unlocks: "News stream with free-tier daily budget (scarce — use after free floors).",
    docsUrl: "https://www.marketaux.com/"
  },
  {
    service: "earningscalls",
    label: "EarningsCalls.dev",
    category: "Transcripts",
    required: false,
    unlocks: "Earnings-call transcripts (preview vs paid entitlement).",
    docsUrl: "https://earningscalls.dev"
  },
  {
    service: "rapidapi",
    label: "RapidAPI",
    category: "Market data",
    required: false,
    unlocks: "Shared marketplace key for RapidAPI-hosted finance hosts (scarce daily budgets).",
    docsUrl: "https://rapidapi.com/"
  },
  {
    service: "fintechstudios",
    label: "Fintech Studios",
    category: "Market sentiment",
    required: false,
    unlocks: "AI financial news analysis, institutional intelligence, and real-time market sentiment.",
    docsUrl: "https://www.fintechstudios.com/"
  },
  {
    service: "apify",
    label: "Apify",
    category: "Scrapers",
    required: false,
    unlocks: "Custom web scrapers, social intelligence, and automated market research actors.",
    docsUrl: "https://console.apify.com/account/integrations"
  },
  {
    service: "logodev",
    label: "Logo.dev",
    category: "Logos",
    required: false,
    credentialName: "publishable token",
    unlocks: "High-resolution company and ticker logos across all market assets.",
    docsUrl: "https://logo.dev"
  }
] as const;

const VALID_SERVICES: ReadonlySet<string> = new Set(API_KEY_CATALOG.map((item) => item.service));
const ST_PRIMARY_BRIDGE_SERVICES: ReadonlySet<string> = new Set(["gemini", "deepseek"]);
const PLAN_TIER_SERVICES = servicesWithPlanTierUi();

function queuePrimaryBridgeAfterTrackedMutation(userId: string, service: string): void {
  if (userId === LOCAL_USER && ST_PRIMARY_BRIDGE_SERVICES.has(service)) {
    queueStPrimaryBridgeWriterSync();
  }
}

function planTierFields(service: string, storedPlanTier?: string | null) {
  if (!PLAN_TIER_SERVICES.has(service)) {
    return { planTier: undefined as string | undefined, planTierOptions: undefined as undefined };
  }
  const options = planTierOptionsForService(service) ?? [];
  const planTier = storedPlanTier && storedPlanTier.length > 0 ? storedPlanTier : defaultPlanTierForService(service);
  return {
    planTier,
    planTierOptions: options
  };
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const userId = resolveRequestUserId(request);
  const service = searchParams.get("service");

  // A key's masked preview (first 8 + last 4, never a usable value) answers "WHICH key is serving
  // me?" — the question the write-only key store otherwise makes unanswerable when several keys
  // exist for one provider. Your OWN stored key is always previewable to you; the operator's env
  // credential is previewable only to an operator/admin, so a tenant riding the shared key can see
  // that one is serving them ("server key") without learning anything about the operator's secret.
  // Token-based admin is excluded on purpose: this is an interactive, identity-bound disclosure.
  const isOperator = checkAdmin(request, { allowToken: false }).ok;
  const previewFor = (resolved: { key?: string; source: string }): string | undefined =>
    resolved.source === "user" || isOperator ? maskApiKeyPreview(resolved.key) : undefined;

  // If a specific service is requested, resolve the key (user DB → env fallback)
  if (service) {
    const canonical = normalizeApiKeyService(service);
    if (!VALID_SERVICES.has(canonical)) {
      return NextResponse.json({ error: `Invalid service. Must be one of: ${[...VALID_SERVICES].join(", ")}` }, { status: 400 });
    }
    const resolved = resolveApiKeyWithSource(canonical, userId);
    const keys = listUserApiKeys(userId);
    const stored = keys.find((k) => normalizeApiKeyService(k.service) === canonical);
    const tiers = planTierFields(canonical, stored?.planTier);
    return NextResponse.json({
      service: canonical,
      configured: Boolean(resolved.key),
      source: resolved.source,
      envVar: resolved.envVar,
      preview: previewFor(resolved),
      ...tiers,
      retired: isRetiredMarketDataService(canonical)
      // NOTE: never return the actual key in a GET response for security — `preview` is the
      // elided first-8/last-4 form only (see maskApiKeyPreview).
    });
  }

  // List all keys for the user (mask the actual key values)
  const keys = listUserApiKeys(userId);
  const storedByService = new Map(keys.map((key) => [normalizeApiKeyService(key.service), key]));
  return NextResponse.json({
    keys: API_KEY_CATALOG.map((entry) => {
      const stored = storedByService.get(entry.service);
      const resolved = resolveApiKeyWithSource(entry.service, userId);
      const envVar = apiKeyEnvVarForService(entry.service);
      const tiers = planTierFields(entry.service, stored?.planTier);
      const retired = "retired" in entry && entry.retired === true;
      return {
        ...entry,
        envVar,
        configured: Boolean(resolved.key),
        source: resolved.source,
        preview: previewFor(resolved),
        updatedAt: stored?.updatedAt,
        savedLabel: stored?.label,
        ...tiers,
        retired: retired || isRetiredMarketDataService(entry.service),
        retiredNote: "retiredNote" in entry ? entry.retiredNote : undefined
      };
    })
  });
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      userId?: string;
      service?: string;
      apiKey?: string;
      label?: string;
      planTier?: string | null;
    };
    const { service, apiKey, label, planTier } = body;
    const userId = resolveRequestUserId(request, body);

    const canonical = service ? normalizeApiKeyService(service) : "";
    if (!canonical || !VALID_SERVICES.has(canonical)) {
      return NextResponse.json({ error: `service is required and must be one of: ${[...VALID_SERVICES].join(", ")}` }, { status: 400 });
    }

    // FMP (and any other catalog row marked retired / retired-market-data) cannot be stored for
    // product use — ST does not call those vendors; Congress.Trade owns that class of data.
    if (isRetiredMarketDataService(canonical) || API_KEY_CATALOG.some((e) => e.service === canonical && "retired" in e && e.retired === true)) {
      return NextResponse.json(
        {
          error:
            "This provider is retired on Socratic-Trade. Use Congress.Trade for FMP-class latency / congressional alt-data; do not store a key here."
        },
        { status: 400 }
      );
    }

    if (planTier !== undefined && planTier !== null && planTier !== "") {
      if (!isValidPlanTierForService(canonical, planTier)) {
        const opts = planTierOptionsForService(canonical);
        return NextResponse.json(
          {
            error: opts
              ? `planTier must be one of: ${opts.map((o) => o.id).join(", ")}`
              : "planTier is not supported for this service"
          },
          { status: 400 }
        );
      }
    }

    const hasKey = typeof apiKey === "string" && apiKey.trim().length > 0;
    const hasTierUpdate = planTier !== undefined;

    // Tier-only update: no secret re-paste when a user key exists, OR when a server env key
    // is already serving this service (plan tier attaches to that env credential).
    if (!hasKey && hasTierUpdate) {
      const updated = setUserApiKeyPlanTier(userId, canonical, planTier === "" ? null : planTier);
      if (!updated) {
        return NextResponse.json(
          {
            error:
              "No key for this service — paste an apiKey, or ensure a server env key exists before setting planTier alone."
          },
          { status: 400 }
        );
      }
      queuePrimaryBridgeAfterTrackedMutation(userId, canonical);
      return NextResponse.json({
        success: true,
        key: {
          id: updated.id,
          service: updated.service,
          label: updated.label,
          planTier: updated.planTier ?? defaultPlanTierForService(canonical),
          createdAt: updated.createdAt,
          updatedAt: updated.updatedAt
        }
      });
    }

    if (!hasKey) {
      return NextResponse.json({ error: "apiKey is required and must be a non-empty string (or pass planTier alone to update tier)" }, { status: 400 });
    }

    const result = upsertUserApiKey(
      userId,
      canonical,
      apiKey!.trim(),
      label,
      planTier === undefined ? undefined : planTier === "" ? null : planTier
    );
    queuePrimaryBridgeAfterTrackedMutation(userId, canonical);
    return NextResponse.json({
      success: true,
      key: {
        id: result.id,
        service: result.service,
        label: result.label,
        planTier: result.planTier ?? (PLAN_TIER_SERVICES.has(canonical) ? defaultPlanTierForService(canonical) : undefined),
        createdAt: result.createdAt,
        updatedAt: result.updatedAt
      }
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to save API key" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const userId = resolveRequestUserId(request);
  const service = searchParams.get("service");

  if (!service) {
    return NextResponse.json({ error: "service query parameter is required" }, { status: 400 });
  }

  const canonical = normalizeApiKeyService(service);
  if (!VALID_SERVICES.has(canonical)) {
    return NextResponse.json({ error: `Invalid service. Must be one of: ${[...VALID_SERVICES].join(", ")}` }, { status: 400 });
  }

  const deleted = deleteUserApiKey(userId, canonical);
  queuePrimaryBridgeAfterTrackedMutation(userId, canonical);
  return NextResponse.json({ success: true, deleted });
}
