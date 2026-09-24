export function HumanSignalModal({ onClose }) {
  return (
    <div id="auth-overlay" onClick={onClose}>
      <div id="auth-modal" onClick={e => e.stopPropagation()}>
        <button id="auth-close" onClick={onClose}>×</button>
        <div id="hs-modal-title">The study</div>
        <p id="hs-modal-body">
          When you write in Inkk, your text and the rhythm of your typing (pauses, revisions, bursts) are captured as part of a study into human writing. We use this to study what distinguishes human writing from machine-generated text.
        </p>
        <p className="hs-modal-body" style={{ marginTop: "12px" }}>
          You can opt out, download, or delete your contribution at any time from Notes.
        </p>
      </div>
    </div>
  );
}

// ─── AuthModal ────────────────────────────────────────────────────────────────
