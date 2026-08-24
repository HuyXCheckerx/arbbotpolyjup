import type {
  JupiterPredictionOrderBuild,
  JupiterPredictionOrderStatus,
  JupiterPredictionPosition,
} from "./client.ts";
import type { JupiterForecastSwapExecutor } from "./forecast-swap.ts";
import type {
  JupiterLiveExecutor,
  PreparedJupiterSubmission,
  SubmittedJupiterOrder,
} from "./trading.ts";

export const JUPITER_PREDICTION_MINIMUM_BUY_MICRO_USD = 5_000_000n;

type JupiterExecutionGateway = Pick<
  JupiterLiveExecutor,
  | "ownerPubkey"
  | "prepareBuy"
  | "prepareSell"
  | "prepareClose"
  | "prepareSubmission"
  | "submitPreparedAndWait"
  | "waitForOrder"
  | "getPosition"
  | "claimPosition"
>;

type ForecastExecutionGateway = Pick<
  JupiterForecastSwapExecutor,
  | "ownerPubkey"
  | "prepareBuy"
  | "prepareSell"
  | "prepareClose"
  | "prepareSubmission"
  | "submitPreparedAndWait"
  | "getPosition"
  | "claimPosition"
  | "reclaimPositionRent"
>;

/**
 * Uses Jupiter's recommended Prediction API for Forecast orders that meet its
 * $5 build minimum. Direct Swap V2 is enabled by default for smaller native
 * outcome-token orders. Standard prediction markets have no outcome mint and
 * always use the Prediction API.
 */
export class JupiterHybridLiveExecutor {
  readonly #forecast: ForecastExecutionGateway;
  readonly #prediction: JupiterExecutionGateway;
  readonly #predictionMinimumBuyMicroUsd: bigint;
  readonly #allowSubMinimumForecastSwap: boolean;

  constructor(input: {
    forecast: ForecastExecutionGateway;
    prediction: JupiterExecutionGateway;
    predictionMinimumBuyMicroUsd?: bigint;
    allowSubMinimumForecastSwap?: boolean;
  }) {
    if (input.forecast.ownerPubkey !== input.prediction.ownerPubkey) {
      throw new Error("Jupiter Forecast and Prediction executors use different owners");
    }
    this.#forecast = input.forecast;
    this.#prediction = input.prediction;
    this.#predictionMinimumBuyMicroUsd = input.predictionMinimumBuyMicroUsd ??
      JUPITER_PREDICTION_MINIMUM_BUY_MICRO_USD;
    this.#allowSubMinimumForecastSwap = input.allowSubMinimumForecastSwap ?? true;
  }

  get ownerPubkey(): string {
    return this.#forecast.ownerPubkey;
  }

  async prepareBuy(input: {
    marketId: string;
    depositAmountMicroUsd: bigint;
    outcomeMint?: string;
    isYes?: boolean;
  }): Promise<JupiterPredictionOrderBuild> {
    if (input.outcomeMint && input.depositAmountMicroUsd < this.#predictionMinimumBuyMicroUsd) {
      if (!this.#allowSubMinimumForecastSwap) {
        throw new Error(
          `Jupiter Forecast order $${Number(input.depositAmountMicroUsd) / 1_000_000} is below the ` +
          `$${Number(this.#predictionMinimumBuyMicroUsd) / 1_000_000} Prediction API minimum; ` +
          `sub-minimum direct Swap V2 execution is disabled`,
        );
      }
      return await this.#forecast.prepareBuy(input);
    }
    return await this.#prediction.prepareBuy(input);
  }

  async prepareSell(
    positionPubkey: string,
    contractsMicro: bigint,
  ): Promise<JupiterPredictionOrderBuild> {
    return isForecastSwapPosition(positionPubkey)
      ? await this.#forecast.prepareSell(positionPubkey, contractsMicro)
      : await this.#prediction.prepareSell(positionPubkey, contractsMicro);
  }

  async prepareClose(positionPubkey: string): Promise<JupiterPredictionOrderBuild> {
    return isForecastSwapPosition(positionPubkey)
      ? await this.#forecast.prepareClose(positionPubkey)
      : await this.#prediction.prepareClose(positionPubkey);
  }

  async prepareSubmission(build: JupiterPredictionOrderBuild): Promise<PreparedJupiterSubmission> {
    return isForecastSwapBuild(build)
      ? await this.#forecast.prepareSubmission(build)
      : await this.#prediction.prepareSubmission(build);
  }

  async submitPreparedAndWait(
    prepared: PreparedJupiterSubmission,
    options: { timeoutMs: number; pollMs?: number },
  ): Promise<SubmittedJupiterOrder> {
    return isForecastSwapBuild(prepared.build)
      ? await this.#forecast.submitPreparedAndWait(prepared, options)
      : await this.#prediction.submitPreparedAndWait(prepared, options);
  }

  async waitForOrder(
    orderPubkey: string,
    options: { timeoutMs: number; pollMs?: number },
  ): Promise<JupiterPredictionOrderStatus> {
    return await this.#prediction.waitForOrder(orderPubkey, options);
  }

  async getPosition(positionPubkey: string): Promise<JupiterPredictionPosition> {
    return isForecastSwapPosition(positionPubkey)
      ? await this.#forecast.getPosition(positionPubkey)
      : await this.#prediction.getPosition(positionPubkey);
  }

  async claimPosition(
    positionPubkey: string,
    expectedPayoutMicroUsd?: bigint,
  ): Promise<{ transactionSignature: string; payoutMicroUsd: bigint }> {
    return isForecastSwapPosition(positionPubkey)
      ? await this.#forecast.claimPosition(positionPubkey, expectedPayoutMicroUsd)
      : await this.#prediction.claimPosition(positionPubkey, expectedPayoutMicroUsd);
  }

  async reclaimPositionRent(
    positionPubkey: string,
  ): Promise<{ transactionSignatures: string[]; reclaimedLamports: bigint }> {
    if (!isForecastSwapPosition(positionPubkey)) {
      return { transactionSignatures: [], reclaimedLamports: 0n };
    }
    return await this.#forecast.reclaimPositionRent(positionPubkey);
  }
}

export function jupiterExecutionPath(
  build: JupiterPredictionOrderBuild | null | undefined,
): "prediction_api" | "swap_v2" | null {
  if (!build) return null;
  return isForecastSwapBuild(build) ? "swap_v2" : "prediction_api";
}

function isForecastSwapPosition(positionPubkey: string): boolean {
  return positionPubkey.startsWith("swap-v2:");
}

function isForecastSwapBuild(build: JupiterPredictionOrderBuild): boolean {
  return build.execution.endpoint === "/swap/v2/execute" || isForecastSwapPosition(build.order.positionPubkey);
}
