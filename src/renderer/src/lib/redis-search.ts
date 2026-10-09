export function redisSearchPattern(value: string): string {
  const text = value.trim()
  return !text ? '*' : /[*?\[\\]/.test(text) ? text : `*${text}*`
}

export function canContinueRedisScan(state: {
  closed: boolean
  keys: number
  hasNext: boolean
  fetching: boolean
  error: boolean
  attempts: number
}): boolean {
  return (
    !state.closed &&
    state.keys === 0 &&
    state.hasNext &&
    !state.fetching &&
    !state.error &&
    state.attempts < 100
  )
}
