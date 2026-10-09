import type { DesktopApi } from '../../shared/contracts'
declare global {
  interface Window {
    vork: DesktopApi
  }
}
export {}
