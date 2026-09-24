export function Toasts({ toasts }) {
  if (!toasts.length) return null;
  return (
    <div id="toast-stack">
      {toasts.map(t => (
        <div key={t.id} className={t.type === "hint" ? "toast toast-hint" : "toast"}>{t.message}</div>
      ))}
    </div>
  );
}
