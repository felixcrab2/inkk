import { useState } from "react";

const FORMATS = [
  { v: "pdf",          l: "PDF" },
  { v: "docx",         l: "Word" },
  { v: "png-portrait", l: "Image" },
  { v: "png-square",   l: "Square image" },
];

export function DownloadModal({ onConfirm, onClose, certifies }) {
  const [format, setFormat]                   = useState("pdf");
  const [justify, setJustify]                 = useState(false);
  const [paragraphIndent, setParagraphIndent] = useState(false);
  const [busy, setBusy]                       = useState(false);
  const paged = format !== "docx";

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    await onConfirm({ format, style: { justify, paragraphIndent } });
    setBusy(false);
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={() => { if (!busy) onClose(); }}>
      <form className="modal" onClick={e => e.stopPropagation()} onSubmit={submit}>
        <div className="modal-head">
          <h2>Download</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="seg" role="radiogroup" aria-label="Format">
          {FORMATS.map(o => (
            <button key={o.v} type="button" role="radio" aria-checked={format === o.v} className={format === o.v ? "is-on" : ""} onClick={() => setFormat(o.v)}>{o.l}</button>
          ))}
        </div>
        {paged && (
          <div className="checks">
            <label className="check"><input type="checkbox" checked={justify} onChange={e => setJustify(e.target.checked)} /><span>Justify</span></label>
            <label className="check"><input type="checkbox" checked={paragraphIndent} onChange={e => setParagraphIndent(e.target.checked)} /><span>Indent paragraphs</span></label>
          </div>
        )}
        <p className="modal-note">{certifies ? "The certificate code goes into the file." : "Sign in to put a certificate code in the file."}</p>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? "Preparing" : "Download"}</button>
        </div>
      </form>
    </div>
  );
}
