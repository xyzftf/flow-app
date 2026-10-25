const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('flowDesktop',{
 notify:(title,body)=>ipcRenderer.invoke('flow:notify',{title,body}),
 notificationsSupported:()=>ipcRenderer.invoke('flow:notifications-supported')
});
