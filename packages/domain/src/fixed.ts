export const USD_SCALE = 6;
export const CONTRACT_SCALE = 6;
export const ONE_USD_MICRO = 1_000_000n;
export const ONE_CONTRACT_MICRO = 1_000_000n;

export type ParseRounding = "reject" | "down";

export function parseFixed(
  value: string | number,
  decimals: number,
  rounding: ParseRounding = "reject",
): bigint {
  const input = String(value).trim();
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(input);
  if (!match) {
    throw new Error(`Invalid fixed-point decimal: ${input}`);
  }

  const sign = match[1] === "-" ? -1n : 1n;
  const whole = match[2] ?? "0";
  const fraction = match[3] ?? "";
  const retained = fraction.slice(0, decimals);
  const discarded = fraction.slice(decimals);

  if (rounding === "reject" && /[1-9]/.test(discarded)) {
    throw new Error(`Too many decimal places for scale ${decimals}: ${input}`);
  }

  const scale = 10n ** BigInt(decimals);
  const fractionalUnits = BigInt(retained.padEnd(decimals, "0") || "0");
  return sign * (BigInt(whole) * scale + fractionalUnits);
}

export function parseUsd(value: string | number): bigint {
  return parseFixed(value, USD_SCALE, "reject");
}

export function parseContracts(value: string | number): bigint {
  return parseFixed(value, CONTRACT_SCALE, "down");
}

export function formatFixed(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = absolute / scale;
  const fraction = (absolute % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

export function formatUsd(value: bigint): string {
  return formatFixed(value, USD_SCALE);
}

export function formatContracts(value: bigint): string {
  return formatFixed(value, CONTRACT_SCALE);
}
