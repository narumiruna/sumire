export function collectMarketResults<T>(
  results: readonly PromiseSettledResult<T | undefined>[],
): T[] {
  const values = results.flatMap((result) =>
    result.status === "fulfilled" && result.value ? [result.value] : [],
  )
  const failure = results.find((result) => result.status === "rejected")
  if (values.length === 0 && failure) throw failure.reason
  return values
}
