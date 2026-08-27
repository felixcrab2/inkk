// Safe bridge between the main process (keyboard hook, session control) and the
// renderer (UI, Supabase sync, certificate flow). No Node exposed to the page.

"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("companion", {
  start: (ctx) => ipcRenderer.invoke("companion:start", ctx),
  stop: () => ipcRenderer.invoke("companion:stop"),
  version: () => ipcRenderer.invoke("companion:version"),
  onEvents: (cb) => ipcRenderer.on("companion:events", (_e, evs) => cb(evs)),
  onState: (cb) => ipcRenderer.on("companion:state", (_e, s) => cb(s)),
  onFrontApp: (cb) => ipcRenderer.on("companion:frontapp", (_e, a) => cb(a)),
  onError: (cb) => ipcRenderer.on("companion:error", (_e, m) => cb(m)),
});
