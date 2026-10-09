const history = require('../src/shared/release-history.json')
const pkg = require('../package.json')
const fail = (message) => {
  throw new Error(message)
}
if (pkg.version !== history.version) fail('package.json 与日志版本不同')
if (process.env.VORK_UNSIGNED === '1') fail('正式构建不允许 VORK_UNSIGNED')
if (process.env.VORK_ENABLE_UPDATES !== '1') fail('正式构建须启用 VORK_ENABLE_UPDATES=1')
if (process.platform === 'darwin') {
  for (const key of [
    'CSC_LINK',
    'CSC_KEY_PASSWORD',
    'APPLE_ID',
    'APPLE_APP_SPECIFIC_PASSWORD',
    'APPLE_TEAM_ID',
  ])
    if (!process.env[key]) fail('缺少 macOS 签名/公证变量：' + key)
}
if (process.platform === 'win32')
  for (const key of ['CSC_LINK', 'CSC_KEY_PASSWORD'])
    if (!process.env[key]) fail('缺少 Windows 签名变量：' + key)
console.log('正式构建前置检查通过；不会上传发布')
