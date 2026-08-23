import { stringifyJson } from "../../../packages/domain/src/json.ts";
import { normalizeMarketRule } from "../../../packages/matcher/src/normalize.ts";
import { JupiterClient } from "../../../packages/venue-jupiter/src/client.ts";
import { PolymarketClient } from "../../../packages/venue-polymarket/src/client.ts";
import { CliArgs } from "./args.ts";

async function main(): Promise<void> {
  const args = new CliArgs(process.argv.slice(2));
  if (args.has("help")) {
    console.log(`Usage:
  pnpm book -- --venue=polymarket --market-id=3257342
  pnpm book -- --venue=jupiter --market-id=POLY-3257342`);
    return;
  }

  const venue = args.required("venue").toLowerCase();
  const marketId = args.required("market-id");
  if (venue === "polymarket") {
    const client = new PolymarketClient();
    const market = await client.getMarket(marketId);
    const book = await client.getOrderBook(market);
    console.log(stringifyJson({ market, rule: normalizeMarketRule(market), book }));
    return;
  }
  if (venue === "jupiter") {
    const client = new JupiterClient();
    const market = await client.getMarket(marketId);
    const book = await client.getOrderBook(market);
    console.log(stringifyJson({ market, rule: normalizeMarketRule(market), book }));
    return;
  }
  throw new Error(`Unsupported venue: ${venue}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
