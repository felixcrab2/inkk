// Three views: the editor at "/", your notes at "/notes", and certify at
// "/certify" (a code deep-links as "/v/<code>", the address printed into PDFs).
// Old addresses (/profile, /verify, and the retired social routes) still resolve
// so nothing anyone bookmarked breaks.
export function viewToPath(view, code) {
  if (view === "notes")   return "/notes";
  if (view === "certify") return code ? `/v/${code}` : "/certify";
  return "/";
}

export function pathToView(path) {
  if (path.startsWith("/v/") || path === "/verify" || path === "/certify") return "certify";
  if (path === "/profile" || path === "/notes" || path === "/privacy" || path === "/terms" || path === "/signin") return "notes";
  return "editor";
}

// "/privacy" and "/terms" (linked from the companion and from emails) open the
// legal text over the Notes page rather than needing pages of their own.
export function pathToLegal(path) {
  if (path === "/privacy") return "privacy";
  if (path === "/terms")   return "terms";
  return null;
}
