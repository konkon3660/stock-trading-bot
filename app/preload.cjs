'use strict';
// 화면(ui/)이 쓸 수 있는 것만 열어 둬요. 화면은 파일·프로세스에 직접 손대지 못해요.
const { contextBridge, ipcRenderer } = require('electron');
const call = (ch, ...a) => ipcRenderer.invoke(ch, ...a);
contextBridge.exposeInMainWorld('api', {
  snapshot: () => call('snapshot'),
  log: key => call('log', key),
  setMode: (key, mode) => call('setMode', key, mode),
  restart: key => call('restart', key),
  takeOver: key => call('takeOver', key),
  setFlag: (name, on) => call('setFlag', name, on),
  refreshAccount: () => call('refreshAccount'),
  setSetting: (key, value) => call('setSetting', key, value),
  makeShortcuts: () => call('makeShortcuts'),
  openPath: what => call('openPath', what),
  quit: () => call('quit'),
  on: (channel, fn) => { if (['changed', 'line'].includes(channel)) ipcRenderer.on(channel, (_e, ...a) => fn(...a)); },
});
