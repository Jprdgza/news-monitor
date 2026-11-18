// Exposes a small, safe API to the UI (window.api). The UI can't touch Node or Electron directly.
import { contextBridge, ipcRenderer } from 'electron';

const invoke = (channel: string) => (...args: unknown[]) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('api', {
  onState: (fn: (s: unknown) => void) => {
    ipcRenderer.removeAllListeners('state');
    ipcRenderer.on('state', (_e, s) => fn(s));
  },
  getState: invoke('getState'),
  selectTab: invoke('selectTab'),
  nav: invoke('nav'),
  openStory: invoke('openStory'),
  feedback: invoke('feedback'),
  days: invoke('days'),
  dayDigest: invoke('dayDigest'),
  whatsNew: invoke('whatsNew'),
  morningDigest: invoke('morningDigest'),
  alerts: invoke('alerts'),
  markAlertsSeen: invoke('markAlertsSeen'),
  flaggedNow: invoke('flaggedNow'),
  runCheck: invoke('runCheck'),
  getConfig: invoke('getConfig'),
  getDefaults: invoke('getDefaults'),
  saveConfig: invoke('saveConfig'),
  listSources: invoke('listSources'),
  resetPrefs: invoke('resetPrefs'),
  themeOptions: invoke('themeOptions'),
  openConfigFile: invoke('openConfigFile'),
  openLog: invoke('openLog'),
  showWindow: invoke('showWindow'),
  dismissOnboarding: invoke('dismissOnboarding'),
  downloadUpdate: invoke('downloadUpdate'),
});
