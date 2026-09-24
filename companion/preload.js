// inkk companion — the `window.inkk` bridge.
//
// The only door between the popover page and the main process. Every call is
// an ipc invoke to a named channel; every subscription returns its own
// unsubscribe. No Node, no Electron object reaches the page (contextIsolation
// on, nodeIntegration off). The shape is the `window.inkk` contract in the
// spec — the renderer is written against exactly this.

"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const invoke = (channel, ...args) => ipcRenderer.invoke(`inkk:${channel}`, ...args);

// Subscribe to a push channel; returns () => void to unsubscribe.
function on(channel, cb) {
  const handler = (_event, payload) => cb(payload);
  ipcRenderer.on(`inkk:${channel}`, handler);
  return () => ipcRenderer.removeListener(`inkk:${channel}`, handler);
}

contextBridge.exposeInMainWorld("inkk", {
  // reads
  getState: () => invoke("getState"),
  getSessions: () => invoke("getSessions"),
  getSession: (id) => invoke("getSession", id),

  // sessions
  endSession: (id) => invoke("endSession", id ?? null),
  deleteSession: (id) => invoke("deleteSession", id),
  certify: (sessionId) => invoke("certify", sessionId),
  sign: () => invoke("sign"),
  previewSignature: () => invoke("previewSignature"),

  // account (held by main; see lib/auth.js)
  signIn: (email, password) => invoke("signIn", String(email ?? ""), String(password ?? "")),
  signOut: () => invoke("signOut"),
  importSession: (tokens) => invoke("importSession", tokens),

  // permissions
  requestPermission: (kind) => invoke("requestPermission", kind),
  openPermissionSettings: (kind) => invoke("openPermissionSettings", kind),

  // settings
  setOnboarded: (v) => invoke("setOnboarded", !!v),
  setPaused: (untilMs) => invoke("setPaused", untilMs ?? null),
  setLaunchAtLogin: (v) => invoke("setLaunchAtLogin", !!v),
  setIgnoredApps: (list) => invoke("setIgnoredApps", Array.isArray(list) ? list : []),
  setReceive: (v) => invoke("setReceive", !!v),
  setSetting: (key, value) => invoke("setSetting", String(key), value),

  // app
  relaunch: () => { ipcRenderer.send("inkk:relaunch"); },
  quit: () => { ipcRenderer.send("inkk:quit"); },
  hide: () => { ipcRenderer.send("inkk:hide"); },
  copyText: (t) => invoke("copyText", String(t ?? "")),
  openExternal: (url) => invoke("openExternal", String(url ?? "")),
  revealFile: (p) => invoke("revealFile", String(p ?? "")),
  resize: (h) => { ipcRenderer.send("inkk:resize", Number(h) || 0); },

  // pushes from main
  onState: (cb) => on("state", cb),
  onSessions: (cb) => on("sessions", cb),
  onShown: (cb) => on("shown", () => cb()),
});
