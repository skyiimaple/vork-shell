const path = require('node:path')
const unsigned = process.env.VORK_UNSIGNED === '1'
if (unsigned && process.env.VORK_ENABLE_UPDATES === '1')
  throw new Error('未签名构建不能启用在线更新')
module.exports = {
  appId: 'com.skyiimaple.vork-shell',
  productName: 'Vork Shell',
  directories: { output: 'release' },
  files: ['out/**/*', 'package.json'],
  asar: true,
  npmRebuild: false,
  electronDist:
    process.env.VORK_USE_LOCAL_ELECTRON === '1'
      ? path.join(path.dirname(require.resolve('electron/package.json')), 'dist')
      : undefined,
  artifactName: 'Vork-Shell-${version}-${os}-${arch}.${ext}',
  forceCodeSigning: !unsigned && process.platform !== 'linux',
  publish: [{ provider: 'github', owner: 'skyiimaple', repo: 'vork-shell', releaseType: 'draft' }],
  mac: {
    icon: 'build/icon.icns',
    target: ['dmg', 'zip'],
    category: 'public.app-category.developer-tools',
    hardenedRuntime: true,
    identity: unsigned ? null : undefined,
    notarize: !unsigned,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
  },
  dmg: { title: 'Vork Shell ${version}' },
  win: { icon: 'build/icon.png', target: ['nsis'] },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    deleteAppDataOnUninstall: false,
  },
  linux: { icon: 'build/icon.png', target: ['AppImage'], category: 'Development' },
}
