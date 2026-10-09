import type { UpdateState, UpdateAction } from '../shared/contracts'
interface Updater {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowDowngrade: boolean
  on(
    event: 'update-available' | 'update-downloaded',
    handler: (value: { version: string }) => void,
  ): unknown
  on(event: 'update-not-available', handler: () => void): unknown
  on(event: 'download-progress', handler: (value: { percent: number }) => void): unknown
  on(event: 'error', handler: (value: Error) => void): unknown
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
}
export class UpdateService {
  private current: UpdateState
  private busy = false
  constructor(
    private updater: Updater,
    enabled: boolean,
    version: string,
    private install: () => Promise<boolean | void>,
  ) {
    this.current = { currentVersion: version, status: enabled ? 'idle' : 'disabled' }
    updater.autoDownload = false
    updater.autoInstallOnAppQuit = false
    updater.allowDowngrade = false
    if (!enabled) return
    updater.on('update-available', (info) => {
      this.current = {
        ...this.current,
        status: 'available',
        version: String(info.version),
        error: undefined,
      }
    })
    updater.on('update-not-available', () => {
      this.current = { currentVersion: version, status: 'latest' }
    })
    updater.on('download-progress', (value) => {
      if (this.current.status === 'downloading')
        this.current.percent = Math.max(0, Math.min(100, Number(value.percent) || 0))
    })
    updater.on('update-downloaded', (info) => {
      this.current = {
        ...this.current,
        status: 'downloaded',
        version: String(info.version),
        percent: 100,
        error: undefined,
      }
    })
    updater.on('error', (error) => {
      this.current = {
        ...this.current,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      }
    })
  }
  state(): UpdateState {
    return { ...this.current }
  }
  async action(action: UpdateAction): Promise<UpdateState> {
    if (!['check', 'download', 'install'].includes(action)) throw new Error('更新操作无效')
    if (this.current.status === 'disabled')
      throw new Error('此版本未启用在线更新，请从发布渠道下载新版本')
    if (this.busy) throw new Error('更新操作正在进行')
    if (action === 'download' && this.current.status !== 'available')
      throw new Error('请先检查可用更新')
    if (action === 'install' && this.current.status !== 'downloaded')
      throw new Error('请先完成更新下载')
    this.busy = true
    try {
      if (action === 'check') {
        this.current = { currentVersion: this.current.currentVersion, status: 'checking' }
        await this.updater.checkForUpdates()
      }
      if (action === 'download') {
        this.current = { ...this.current, status: 'downloading', percent: 0, error: undefined }
        await this.updater.downloadUpdate()
      }
      if (action === 'install') {
        this.current.status = 'installing'
        if ((await this.install()) === false) this.current.status = 'downloaded'
      }
    } catch (error) {
      this.current = {
        ...this.current,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      }
      throw error
    } finally {
      this.busy = false
    }
    return this.state()
  }
}
