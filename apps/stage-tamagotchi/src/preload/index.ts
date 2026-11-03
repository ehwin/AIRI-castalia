import type { ElectronWindow } from '@proj-airi/stage-shared'

import { contextIsolated } from 'node:process'

import { electronAPI } from '@electron-toolkit/preload'
import { contextBridge, ipcRenderer } from 'electron'

const api = {
  bailianSpeechSynthesize: (endpoint: string, apiKey: string, body: string, requestId?: string) => ipcRenderer.invoke('airi:bailian:synthesize', endpoint, apiKey, body, requestId) as Promise<Uint8Array>,
  /** Fire-and-forget: main aborts the matching request and drops its result. */
  bailianSpeechCancel: (requestId: string) => ipcRenderer.send('airi:bailian:cancel', requestId),
}

if (contextIsolated) {
  contextBridge.exposeInMainWorld('electron', electronAPI)
  contextBridge.exposeInMainWorld('platform', process.platform)
  contextBridge.exposeInMainWorld('api', api)
}
else {
  window.electron = electronAPI
  window.platform = process.platform
  ;(window as ElectronWindow<typeof api>).api = api
}
