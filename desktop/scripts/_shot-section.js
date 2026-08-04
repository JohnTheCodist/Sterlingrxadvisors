const { app, BrowserWindow } = require('electron');
const path = require('path'); const fs = require('fs');
app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 1280, height: 960, show: false, backgroundColor: '#fff',
    webPreferences: { sandbox: true, contextIsolation: true } });
  await w.loadURL('http://localhost:5173/');
  await new Promise(r => setTimeout(r, 3000));
  const found = await w.webContents.executeJavaScript(`(() => {
    const el = document.querySelector('.problem-grid');
    if (!el) return null;
    el.scrollIntoView({ block: 'start' });
    window.scrollBy(0, -70);
    return { text: el.innerText.replace(/\n+/g,' | ').slice(0, 700) };
  })()`);
  await new Promise(r => setTimeout(r, 900));
  fs.writeFileSync(path.join(__dirname, '..', 'section.png'), (await w.webContents.capturePage()).toPNG());
  console.log(found ? found.text : 'SECTION NOT FOUND');
  app.exit(0);
});
app.on('window-all-closed', () => {});
