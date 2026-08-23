import { formatContracts, formatUsd } from "../../../packages/domain/src/fixed.ts";
import { stringifyJson } from "../../../packages/domain/src/json.ts";
import type { BinaryOrderBook, MarketMatch, MatchVerdict, VenueMarket } from "../../../packages/domain/src/types.ts";
import { discoverMarketMatches } from "../../../packages/matcher/src/match.ts";
import { normalizeMarketRule } from "../../../packages/matcher/src/normalize.ts";
import { JupiterClient } from "../../../packages/venue-jupiter/src/client.ts";
import { PolymarketClient } from "../../../packages/venue-polymarket/src/client.ts";
import { CliArgs } from "./args.ts";

interface BookResult {
  polymarket: ReturnType<typeof summarizeBook> | null;
  jupiter: ReturnType<typeof summarizeBook> | null;
  errors: readonly string[];
}

interface ScanOutput {
  generatedAt: string;
  configuration: {
    assets: readonly string[];
    jupiterProviders: readonly string[];
  };
  counts: {
    polymarketMarkets: number;
    jupiterMarkets: number;
    byProvider: Readonly<Record<string, number>>;
    verdicts: Readonly<Record<MatchVerdict, number>>;
  };
  matches: readonly (MarketMatch & { books?: BookResult })[];
}

async function main(): Promise<void> {
  const args = new CliArgs(process.argv.slice(2));
  if (args.has("help")) {
    printHelp();
    return;
  }

  const assets = args.csv("assets", ["BTC", "ETH", "SOL", "XRP"]).map((asset) => asset.toUpperCase());
  const providers = args.csv("jupiter-providers", ["polymarket", "kalshi"]).map((provider) => provider.toLowerCase());
  const maxMatches = args.integer("max-matches", 30);
  const bookLimit = args.integer("book-limit", 3);
  const polyClient = new PolymarketClient();
  const jupiterClient = new JupiterClient();

  const [polymarketsRaw, providerResults] = await Promise.all([
    polyClient.searchCryptoMarkets(assets, {
      maxPagesPerAsset: args.integer("poly-pages", 2),
      limitPerType: args.integer("poly-page-size", 50),
    }),
    Promise.all(
      providers.map(async (provider) => {
        const batches = await Promise.all(
          assets.map((asset) => jupiterClient.getMarkets({
            provider,
            category: "crypto",
            subcategory: asset.toLowerCase(),
            sortBy: "beginAt",
            sortDirection: "desc",
            maxEvents: args.integer("max-jupiter-events", 100),
            pageSize: args.integer("jupiter-page-size", 100),
          })),
        );
        return { provider, markets: uniqueMarkets(batches.flat()) };
      }),
    ),
  ]);

  const polymarkets = filterPriceThresholdMarkets(polymarketsRaw, assets);
  const jupiterMarkets = filterPriceThresholdMarkets(
    providerResults.flatMap((result) => result.markets),
    assets,
  );
  const matches = discoverMarketMatches(polymarkets, jupiterMarkets, {
    includeRejected: args.has("include-rejected"),
    maxCloseDifferenceMs: args.integer("max-close-hours", 24) * 60 * 60 * 1_000,
  }).slice(0, maxMatches);

  const withBooks: (MarketMatch & { books?: BookResult })[] = [...matches];
  if (args.has("with-orderbooks")) {
    for (let index = 0; index < Math.min(bookLimit, withBooks.length); index += 1) {
      const match = withBooks[index];
      if (!match) continue;
      match.books = await fetchBookPair(match, polyClient, jupiterClient);
    }
  }

  const output: ScanOutput = {
    generatedAt: new Date().toISOString(),
    configuration: { assets, jupiterProviders: providers },
    counts: {
      polymarketMarkets: polymarkets.length,
      jupiterMarkets: jupiterMarkets.length,
      byProvider: Object.fromEntries(
        providerResults.map((result) => [
          result.provider,
          filterPriceThresholdMarkets(result.markets, assets).length,
        ]),
      ),
      verdicts: countVerdicts(withBooks),
    },
    matches: withBooks,
  };

  if (args.has("json")) {
    process.stdout.write(`${stringifyJson(output)}\n`);
  } else {
    printHuman(output);
  }
}

function filterPriceThresholdMarkets(markets: readonly VenueMarket[], assets: readonly string[]): VenueMarket[] {
  const assetSet = new Set(assets);
  return markets.filter((market) => {
    if (market.status !== "open") return false;
    const rule = normalizeMarketRule(market);
    return (
      rule.asset !== null &&
      assetSet.has(rule.asset) &&
      rule.thresholdMicroUsd !== null &&
      rule.comparison !== "UNKNOWN" &&
      rule.observationMode !== "UNKNOWN"
    );
  });
}

function uniqueMarkets(markets: readonly VenueMarket[]): VenueMarket[] {
  return [...new Map(markets.map((market) => [`${market.provider}:${market.marketId}`, market])).values()];
}

async function fetchBookPair(
  match: MarketMatch,
  polyClient: PolymarketClient,
  jupiterClient: JupiterClient,
): Promise<BookResult> {
  const errors: string[] = [];
  const [polyResult, jupiterResult] = await Promise.allSettled([
    polyClient.getOrderBook(match.polymarket),
    jupiterClient.getOrderBook(match.jupiter),
  ]);
  if (polyResult.status === "rejected") errors.push(`Polymarket: ${errorMessage(polyResult.reason)}`);
  if (jupiterResult.status === "rejected") errors.push(`Jupiter: ${errorMessage(jupiterResult.reason)}`);
  return {
    polymarket: polyResult.status === "fulfilled" ? summarizeBook(polyResult.value) : null,
    jupiter: jupiterResult.status === "fulfilled" ? summarizeBook(jupiterResult.value) : null,
    errors,
  };
}

function summarizeBook(book: BinaryOrderBook): object {
  return {
    venue: book.venue,
    provider: book.provider,
    marketId: book.marketId,
    receivedAt: new Date(book.receivedAtMs).toISOString(),
    sourceTimestamp: book.sourceTimestampMs === null ? null : new Date(book.sourceTimestampMs).toISOString(),
    yes: summarizeSide(book.yes),
    no: summarizeSide(book.no),
  };
}

function summarizeSide(side: BinaryOrderBook["yes"]): object {
  const bestBid = side.bids[0];
  const bestAsk = side.asks[0];
  return {
    bestBid: bestBid ? formatUsd(bestBid.priceMicroUsd) : null,
    bestBidContracts: bestBid ? formatContracts(bestBid.contractsMicro) : null,
    bestAsk: bestAsk ? formatUsd(bestAsk.priceMicroUsd) : null,
    bestAskContracts: bestAsk ? formatContracts(bestAsk.contractsMicro) : null,
    bidLevels: side.bids.length,
    askLevels: side.asks.length,
  };
}

function countVerdicts(matches: readonly MarketMatch[]): Record<MatchVerdict, number> {
  const counts: Record<MatchVerdict, number> = {
    EXACT: 0,
    REVIEW_REQUIRED: 0,
    SHARED_LIQUIDITY: 0,
    BASIS: 0,
    REJECT: 0,
  };
  for (const match of matches) counts[match.verdict] += 1;
  return counts;
}

function printHuman(output: ScanOutput): void {
  console.log(`Polymarket price-threshold markets: ${output.counts.polymarketMarkets}`);
  console.log(`Jupiter price-threshold markets: ${output.counts.jupiterMarkets}`);
  console.log(`Jupiter providers: ${Object.entries(output.counts.byProvider).map(([key, value]) => `${key}=${value}`).join(", ")}`);
  console.log(`Matches: ${Object.entries(output.counts.verdicts).map(([key, value]) => `${key}=${value}`).join(", ")}`);

  for (const [index, match] of output.matches.entries()) {
    const polyThreshold = match.polyRule.thresholdMicroUsd === null ? "?" : `$${formatUsd(match.polyRule.thresholdMicroUsd)}`;
    const jupThreshold = match.jupiterRule.thresholdMicroUsd === null ? "?" : `$${formatUsd(match.jupiterRule.thresholdMicroUsd)}`;
    console.log(`\n${index + 1}. [${match.verdict}] score=${match.score}`);
    console.log(`   Polymarket ${match.polymarket.marketId}: ${match.polymarket.title}`);
    console.log(`   Jupiter/${match.jupiter.provider} ${match.jupiter.marketId}: ${match.jupiter.title}`);
    console.log(`   Terms: ${match.polyRule.asset ?? "?"} ${match.polyRule.comparison} ${polyThreshold} vs ${match.jupiterRule.comparison} ${jupThreshold}`);
    console.log(`   Oracle: ${match.polyRule.oracle ?? "?"} vs ${match.jupiterRule.oracle ?? "?"}`);
    for (const reason of match.reasons) console.log(`   - ${reason}`);
    if (match.books) console.log(`   Books: ${stringifyJson(match.books, false)}`);
  }

  if (output.matches.length === 0) {
    console.log("\nNo same-strike/time candidates were found in the configured discovery window.");
  }
}

function printHelp(): void {
  console.log(`Usage: pnpm scan -- [options]

Options:
  --assets=BTC,ETH,SOL,XRP
  --jupiter-providers=polymarket,kalshi
  --max-jupiter-events=100       Per provider/asset subcategory
  --jupiter-page-size=100
  --poly-pages=2
  --poly-page-size=50
  --max-close-hours=24
  --max-matches=30
  --include-rejected
  --with-orderbooks
  --book-limit=3
  --json
  --help`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
