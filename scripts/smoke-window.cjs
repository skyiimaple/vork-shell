// Test windows stay hidden until they can be shown on a secondary display.
const { app, screen } = require('electron')
process.env.VORK_TEST_WINDOW = '1'
app.on('browser-window-created', (_, window) => {
  const primary = screen.getPrimaryDisplay()
  const secondary = screen.getAllDisplays().find((display) => display.id !== primary.id)
  if (!secondary) {
    console.log('No secondary display: test window stays hidden')
    return
  }
  const area = secondary.workArea
  window.setBounds({
    x: area.x,
    y: area.y,
    width: Math.min(1280, area.width),
    height: Math.min(800, area.height),
  })
  window.webContents.once('did-finish-load', () => {
    if (!window.isDestroyed()) window.showInactive()
  })
  console.log('Test window on secondary display:', secondary.id)
})
