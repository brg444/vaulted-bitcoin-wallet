/** Half-hour confirmation target. Operational fee, not the enrolled ceiling. */
export const ONCHAIN_FEE_TARGET_BLOCKS = 3

export function satPerVFromFeeEstimates(
  estimates: Record<string, number>,
  targetBlocks = ONCHAIN_FEE_TARGET_BLOCKS,
): number {
  const keys = Object.keys(estimates)
    .map((key) => Number(key))
    .filter((key) => Number.isInteger(key) && key > 0)
    .sort((a, b) => a - b)
  if (keys.length === 0) throw new Error('fee estimates are missing')
  const chosen = keys.find((key) => key >= targetBlocks) ?? keys[keys.length - 1]
  const satPerV = Number(estimates[String(chosen)])
  if (!Number.isFinite(satPerV) || satPerV <= 0) throw new Error('fee estimates are invalid')
  return satPerV
}
