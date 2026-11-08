export function financePolicy(env = process.env) {
  const hours = (key, fallback) => {
    const value = Number(env[key] ?? fallback)
    if (!Number.isInteger(value) || value < 1 || value > 168) throw Error(`${key} must be an integer from 1 to 168`)
    return value
  }
  return { version: 1, freeCancellationHours: hours('PAYMENT_FREE_CANCELLATION_HOURS', 24), settlementHoldHours: hours('PAYMENT_SETTLEMENT_HOLD_HOURS', 48), feeBps: 1000 }
}
