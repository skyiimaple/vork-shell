import { expect, it } from 'vitest'
import { restoreWindowState } from '../src/main/window-state'
it('restores valid normal bounds and maximization, moves disconnected display windows to primary', () => {
  const displays = [{ x: 0, y: 0, width: 1920, height: 1080 }]
  expect(
    restoreWindowState({ x: 80, y: 40, width: 1100, height: 700, maximized: true }, displays),
  ).toEqual({ x: 80, y: 40, width: 1100, height: 700, maximized: true })
  const restored = restoreWindowState({ x: -5000, y: 0, width: 2000, height: 1300 }, displays)
  expect(restored.x).toBeGreaterThanOrEqual(0)
  expect(restored.width).toBeLessThanOrEqual(1920)
  expect(restoreWindowState({ width: NaN, height: -1 }, displays).width).toBe(1380)
})
