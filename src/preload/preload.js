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
    getAppInfo: invoke('getAppInfo'),
    openExternal: invoke('openExternal'),
    openNdiLicenses: invoke('openNdiLicenses'),
    // Asks for a port to the NDI process; it arrives as a window "message" event (see below).
    ndiConnect: () => ipcRenderer.send('ndi:connect'),
});

// MessagePorts can't cross contextBridge, so the NDI preview port is handed to
// the page with window.postMessage, restricted to this page's own origin.
ipcRenderer.on('ndi:port', (event) => {
    window.postMessage({ type: 'rcp:ndi-port' }, window.location.origin, event.ports);
});
