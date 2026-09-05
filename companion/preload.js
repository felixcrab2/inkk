// Safe bridge between the main process (keyboard hook, session control) and the
// renderer (UI, Supabase sync, certificate flow). No Node exposed to the page.

"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("companion", {
  auth: (userId) => ipcRenderer.invoke("companion:auth", userId),  // enable/disable auto-arm
  end: () => ipcRenderer.invoke("companion:end"),                  // finish the current session
  state: () => ipcRenderer.invoke("companion:state"),
  version: () => ipcRenderer.invoke("companion:version"),
  onEvents: (cb) => ipcRenderer.on("companion:events", (_e, evs) => cb(evs)),
  onState: (cb) => ipcRenderer.on("companion:state", (_e, s) => cb(s)),
  onError: (cb) => ipcRenderer.on("companion:error", (_e, m) => cb(m)),
});
