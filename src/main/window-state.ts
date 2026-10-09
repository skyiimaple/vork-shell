import { readFileSync, writeFileSync, renameSync } from 'node:fs'
export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}
export interface WindowState extends Bounds {
  maximized: boolean
}
export function restoreWindowState(input: unknown, displays: Bounds[]): WindowState {
  const source = input && typeof input === 'object' ? (input as Partial<WindowState>) : {}
  const primary = displays[0] || { x: 0, y: 0, width: 1920, height: 1080 }
  const size = (value: unknown, fallback: number, minimum: number) =>
    typeof value === 'number' && Number.isFinite(value) && value >= minimum
      ? Math.round(value)
      : fallback
  let width = size(source.width, 1380, 960),
    height = size(source.height, 900, 640)
  const x = Number.isFinite(source.x) ? source.x! : primary.x + 40
  const y = Number.isFinite(source.y) ? source.y! : primary.y + 40
  const display =
    displays.find(
      (d) => x + width > d.x + 80 && x < d.x + d.width - 80 && y >= d.y && y < d.y + d.height - 40,
    ) || primary
  width = Math.min(width, display.width)
  height = Math.min(height, display.height)
  return {
    x: Math.max(display.x, Math.min(x, display.x + display.width - width)),
    y: Math.max(display.y, Math.min(y, display.y + display.height - height)),
    width,
    height,
    maximized: source.maximized === true,
  }
}
export function readWindowState(path: string, displays: Bounds[]) {
  let input: unknown
  try {
    input = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    /* Missing or damaged state uses defaults. */
  }
  return restoreWindowState(input, displays)
}
export function saveWindowState(path: string, state: WindowState) {
  const temporary = path + '.tmp'
  writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 })
  renameSync(temporary, path)
}
