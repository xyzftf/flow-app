const { app, BrowserWindow, shell, dialog, ipcMain, Notification } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const { execFileSync } = require('child_process');

app.setAppUserModelId('com.flow.organizer');
let server;
let updatePromptOpen = false;
const gotLock = app.requestSingleInstanceLock();
if(!gotLock) app.quit();

function loadWindowsUserApiKey(){
  if(process.platform !== 'win32' || process.env.OPENAI_API_KEY) return;
  try{
    const out = execFileSync('reg', ['query','HKCU\\Environment','/v','OPENAI_API_KEY'], {encoding:'utf8', windowsHide:true});
    const match = out.match(/OPENAI_API_KEY\s+REG_\w+\s+([^\r\n]+)/i);
    if(match && match[1]) process.env.OPENAI_API_KEY = match[1].trim();
  }catch(e){
    console.log('OPENAI_API_KEY is not configured for this Windows user');
  }
}

async function createWindow(){
  loadWindowsUserApiKey();
  process.env.FLOW_DATA_DIR = path.join(app.getPath('userData'), 'data');
  const { startServer } = require('./server');
  let started;
  try {
    started = await startServer(32147);
  } catch (error) {
    if(error.code !== 'EADDRINUSE') throw error;
    console.warn('Port 32147 is busy; selecting a free local port');
    started = await startServer(0);
  }
  server = started.server;

  const win = new BrowserWindow({
    width: 1080,
    height: 800,
    minWidth: 720,
    minHeight: 620,
    backgroundColor: '#EDEFEA',
    title: 'Flow',
    icon: path.join(__dirname, 'public', 'icons', 'icon-512.png'),
    webPreferences: { backgroundThrottling: false, preload: path.join(__dirname,'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(({ url })=>{
    if(/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  const trusted=event=>event.sender===win.webContents && event.senderFrame===win.webContents.mainFrame && event.senderFrame.url.startsWith(`http://127.0.0.1:${started.port}/`);
  ipcMain.removeHandler('flow:notifications-supported');ipcMain.removeHandler('flow:notify');
  ipcMain.handle('flow:notifications-supported',event=>trusted(event)&&Notification.isSupported());
  ipcMain.handle('flow:notify',async(event,payload)=>{
    if(!trusted(event)||!Notification.isSupported()||typeof payload?.title!=='string'||typeof payload?.body!=='string')return false;
    return new Promise(resolve=>{
      const notification=new Notification({title:payload.title.slice(0,100),body:payload.body.slice(0,600),icon:path.join(__dirname,'public','icons','icon-192.png')});
      const timer=setTimeout(()=>resolve(false),5000);
      notification.once('show',()=>{clearTimeout(timer);resolve(true);});
      notification.once('failed',()=>{clearTimeout(timer);resolve(false);});
      notification.on('click',()=>{if(win.isMinimized())win.restore();win.show();win.focus();});
      notification.show();
    });
  });
  await win.loadURL(`http://127.0.0.1:${started.port}`);
  setupAutoUpdates(win);
}

function setupAutoUpdates(win){
  if(!app.isPackaged) return;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', async info=>{
    if(updatePromptOpen) return;
    updatePromptOpen = true;
    const result = await dialog.showMessageBox(win, {
      type: 'info',
      title: 'Обновление Flow',
      message: `Доступна версия ${info.version}`,
      detail: 'Скачать обновление сейчас? Аккаунт и задачи сохранятся.',
      buttons: ['Скачать', 'Позже'],
      defaultId: 0,
      cancelId: 1
    });
    updatePromptOpen = false;
    if(result.response === 0) autoUpdater.downloadUpdate();
  });

  autoUpdater.on('download-progress', progress=>{
    win.setProgressBar(Math.max(0, Math.min(1, progress.percent / 100)));
  });

  autoUpdater.on('update-downloaded', async info=>{
    win.setProgressBar(-1);
    const result = await dialog.showMessageBox(win, {
      type: 'info',
      title: 'Flow обновлён',
      message: `Версия ${info.version} готова к установке`,
      detail: 'Перезапустить Flow и установить обновление?',
      buttons: ['Обновить и перезапустить', 'При следующем запуске'],
      defaultId: 0,
      cancelId: 1
    });
    if(result.response === 0) autoUpdater.quitAndInstall(false, true);
  });

  autoUpdater.on('error', error=>{
    win.setProgressBar(-1);
    console.error('Flow update error:', error.message);
  });

  setTimeout(()=>autoUpdater.checkForUpdates().catch(error=>console.error('Update check failed:', error.message)), 5000);
}

app.whenReady().then(createWindow).catch(async error=>{
  console.error('Flow startup failed:', error);
  try {
    await dialog.showMessageBox({
      type: 'error', title: 'Flow не запускается',
      message: 'Не удалось запустить Flow',
      detail: String(error && (error.stack || error.message) || error),
      buttons: ['Закрыть']
    });
  } catch (_) {}
  app.quit();
});

app.on('second-instance', ()=>{
  const win = BrowserWindow.getAllWindows()[0];
  if(win){
    if(win.isMinimized()) win.restore();
    win.focus();
  }
});

app.on('window-all-closed', ()=>{
  if(server) server.close();
  if(process.platform !== 'darwin') app.quit();
});

app.on('activate', ()=>{
  if(BrowserWindow.getAllWindows().length === 0) createWindow();
});
