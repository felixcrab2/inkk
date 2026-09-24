
export function formatWritingTime(secs) {
  if (!secs || secs < 60) return secs ? `${Math.round(secs)}s` : "0s";
  return `${Math.round(secs / 60)} min`;
}

export function formatDate(iso) {
  const diffDays = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  const weeks = Math.floor(diffDays / 7);
  if (weeks < 5) return `${weeks}w ago`;
  const months = Math.floor(diffDays / 30);
  if (months < 12) return `${months}mo ago`;
  return new Date(iso).toLocaleDateString("en-GB", { month: "short", year: "numeric" });
}

export function formatJoined(isoOrDate) {
  if (!isoOrDate) return "";
  return new Date(isoOrDate).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
}

// ─── streak ───────────────────────────────────────────────────────────────────
