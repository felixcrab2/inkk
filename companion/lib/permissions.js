// inkk companion — the two macOS grants the global hook needs.
//
// uiohook's CGEventTap needs Accessibility AND Input Monitoring. Status comes
// from node-mac-permissions (AXIsProcessTrusted / IOHIDCheckAccess), cross-
// checked for accessibility with Electron's own systemPreferences. The native
// module is optional at runtime: if it fails to load we report "not determined"
// and surface the reason, so a broken install degrades to "needs permission"
// rather than a crash at launch.
//
// Statuses are the renderer's PermState: 'granted' | 'denied' |
// 'not determined' | 'restricted'.

"use strict";

let nmp = null;
let loadError = null;
try { nmp = require("node-mac-permissions"); }
catch (e) { loadError = `node-mac-permissions unavailable: ${e.message}`; }

let systemPreferences = null, shell = null;
try { ({ systemPreferences, shell } = require("electron")); } catch { /* plain Node (tests) */ }

const SETTINGS_URL = {
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  inputMonitoring: "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent",
};

const mapStatus = (s) => (s === "authorized" ? "granted" : (s || "not determined"));

function accessibilityStatus() {
  let st = "not determined";
  if (nmp) { try { st = mapStatus(nmp.getAuthStatus("accessibility")); } catch { /* fall through */ } }
  // AXIsProcessTrusted is the ground truth the tap will be judged by.
  try { if (systemPreferences?.isTrustedAccessibilityClient(false)) st = "granted"; } catch { /* not macOS */ }
  return st;
}

function inputMonitoringStatus() {
  if (!nmp) return "not determined";
  try { return mapStatus(nmp.getAuthStatus("input-monitoring")); } catch { return "not determined"; }
}

function status() {
  return { accessibility: accessibilityStatus(), inputMonitoring: inputMonitoringStatus() };
}

const bothGranted = (p) => p.accessibility === "granted" && p.inputMonitoring === "granted";

// Trigger the OS prompt for one grant and report the status afterwards. macOS
// only shows each prompt once; after a "Don't allow" the status is 'denied'
// and the user has to flip the switch in System Settings (openSettings).
async function request(kind) {
  if (kind === "accessibility") {
    // One prompt, not two: Electron's call and node-mac-permissions' both go
    // through AXIsProcessTrustedWithOptions.
    let asked = false;
    try { if (systemPreferences) { systemPreferences.isTrustedAccessibilityClient(true); asked = true; } } catch { /* ignore */ }
    if (!asked) { try { nmp?.askForAccessibilityAccess(); } catch { /* ignore */ } }
  } else if (kind === "inputMonitoring") {
    try { await nmp?.askForInputMonitoringAccess("listen"); } catch { /* ignore */ }
  }
  return status()[kind] || "not determined";
}

async function openSettings(kind) {
  const url = SETTINGS_URL[kind];
  if (url && shell) await shell.openExternal(url);
}

module.exports = { status, request, openSettings, bothGranted, mapStatus, get loadError() { return loadError; } };
