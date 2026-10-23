const { contextBridge, ipcRenderer } = require('electron');

// The renderer's only way into the app: one function per main-process handler,
// each returning the { ok, data } / { ok: false, error, code } envelope.
const invoke = (name) => (body) => ipcRenderer.invoke(`rcp:${name}`, body);

contextBridge.exposeInMainWorld('rcp', {
    getChannels: invoke('getChannels'),
    setControl: invoke('setControl'),
    getConfig: invoke('getConfig'),
    setConfig: invoke('setConfig'),
    listScenes: invoke('listScenes'),
    saveScene: invoke('saveScene'),
    deleteScene: invoke('deleteScene'),
    recallScene: invoke('recallScene'),
    getSettings: invoke('getSettings'),
    saveSettings: invoke('saveSettings'),
});
