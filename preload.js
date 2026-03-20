const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  invokeRpc: (url, method, params, timeoutMs) =>
    ipcRenderer.invoke('wallet-rpc', { url, method, params, timeoutMs }),

  // Remote relay session
  initRemoteSession: (url) => ipcRenderer.invoke('init-remote-session', { url }),
  relayFetch: (baseUrl, path, method, body) =>
    ipcRenderer.invoke('relay-fetch', { baseUrl, path, method, body }),

  // Local node management
  localNodeStart: (opts) => ipcRenderer.invoke('local-node-start', opts),
  localNodeStop: () => ipcRenderer.invoke('local-node-stop'),
  localNodeStatus: (opts) => ipcRenderer.invoke('local-node-status', opts),
  localNodeLog: () => ipcRenderer.invoke('local-node-log'),
  localNodeCheckBinary: () => ipcRenderer.invoke('local-node-check-binary'),
  localNodeSetup: (opts) => ipcRenderer.invoke('local-node-setup', opts),
  localWalletRpcStart: (opts) => ipcRenderer.invoke('local-wallet-rpc-start', opts),
  localWalletRpcStop: () => ipcRenderer.invoke('local-wallet-rpc-stop'),
  // Auto-update
  updateCheck: () => ipcRenderer.invoke('update-check'),
  updateDownload: () => ipcRenderer.invoke('update-download'),
  updateInstall: () => ipcRenderer.invoke('update-install'),
  onUpdateAvailable: (cb) => ipcRenderer.on('update-available', (_, data) => cb(data)),
  onUpdateProgress: (cb) => ipcRenderer.on('update-progress', (_, data) => cb(data)),
  onUpdateDownloaded: (cb) => ipcRenderer.on('update-downloaded', (_, data) => cb(data)),
  onUpdateStatus: (cb) => ipcRenderer.on('update-status', (_, data) => cb(data)),

  // Events from main process
  onLocalNodeStopped: (cb) => ipcRenderer.on('local-node-stopped', (_, data) => cb(data)),
  onLocalWalletRpcStopped: (cb) => ipcRenderer.on('local-wallet-rpc-stopped', (_, data) => cb(data)),
  onBuildProgress: (cb) => ipcRenderer.on('build-progress', (_, data) => cb(data)),
});
