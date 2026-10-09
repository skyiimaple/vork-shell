const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const { resolve } = require('node:path')
const svg = readFileSync(resolve('build/icon.svg'), 'utf8')
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 1024,
    height: 1024,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  try {
    await window.loadURL('data:text/html,<html><body></body></html>')
    const png = await window.webContents.executeJavaScript(
      `(async()=>{const image=new Image();image.src='data:image/svg+xml;base64,'+${JSON.stringify(Buffer.from(svg).toString('base64'))};await image.decode();const canvas=document.createElement('canvas');canvas.width=1024;canvas.height=1024;canvas.getContext('2d').drawImage(image,0,0);return canvas.toDataURL('image/png').split(',')[1]})()`,
    )
    writeFileSync(resolve('build/icon.png'), Buffer.from(png, 'base64'))
    window.destroy()
    console.log('Code-native SVG icon exported')
    app.exit(0)
  } catch (error) {
    console.error(error)
    window.destroy()
    app.exit(1)
  }
})
