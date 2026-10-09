import { test, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { UpdateService } from '../src/main/updates'
class Updater extends EventEmitter {
  autoDownload = true
  autoInstallOnAppQuit = true
  allowDowngrade = true
  checks = 0
  downloads = 0
  async checkForUpdates() {
    this.checks++
    this.emit('update-available', { version: '0.2.0' })
    return {}
  }
  async downloadUpdate() {
    this.downloads++
    this.emit('download-progress', { percent: 42 })
    this.emit('update-downloaded', { version: '0.2.0' })
    return []
  }
}
test('updates require enabled package and explicit check/download/install actions', async () => {
  const u = new Updater()
  let installs = 0
  const disabled = new UpdateService(u, false, '0.1.0', async () => {
    installs++
  })
  await expect(disabled.action('check')).rejects.toThrow()
  expect(u.checks).toBe(0)
  const service = new UpdateService(u, true, '0.1.0', async () => {
    installs++
  })
  expect(u.autoDownload).toBe(false)
  expect(u.autoInstallOnAppQuit).toBe(false)
  expect(u.allowDowngrade).toBe(false)
  await expect(service.action('install')).rejects.toThrow()
  await service.action('check')
  expect(service.state().status).toBe('available')
  expect(u.downloads).toBe(0)
  await service.action('download')
  expect(service.state().status).toBe('downloaded')
  expect(installs).toBe(0)
  await service.action('install')
  expect(installs).toBe(1)
})
test('failure is visible and duplicate work is rejected', async () => {
  const u = new Updater()
  u.checkForUpdates = async () => new Promise(() => {})
  const service = new UpdateService(u, true, '0.1.0', async () => {})
  void service.action('check')
  await expect(service.action('check')).rejects.toThrow()
  u.emit('error', new Error('network unavailable'))
  expect(service.state()).toMatchObject({ status: 'error', error: 'network unavailable' })
})
