import type { Cell } from '../../../shared/contracts'
export function compareCells(a: Cell, b: Cell): number {
  if (a === b) return 0
  if (a === null) return -1
  if (b === null) return 1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (/^-?\d+$/.test(String(a)) && /^-?\d+$/.test(String(b))) {
    const left = BigInt(String(a)),
      right = BigInt(String(b))
    return left < right ? -1 : left > right ? 1 : 0
  }
  return String(a).localeCompare(String(b), undefined, { numeric: true })
}
