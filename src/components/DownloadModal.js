import { useState } from "react";

export function DownloadModal({ onConfirm, onClose }) {
  const [format,          setFormat]          = useState("pdf");
  const [justify,         setJustify]         = useState(false);
  const [paragraphIndent, setParagraphIndent] = useState(false);
  const [busy,            setBusy]            = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    await onConfirm({ format, style: { justify, paragraphIndent } });
    setBusy(false);
    onClose();
  };

  return (
    <div id="auth-overlay">
      <div id="auth-modal">
        <button id="auth-close" onClick={onClose}>×</button>
        <div id="auth-tabs"><button className="active" style={{ cursor: "default" }}>download</button></div>
        <form onSubmit={submit}>
          <div className="dl-section-label">Format</div>
          <div className="dl-radio-row">
            {[
              { v: "pdf",          l: "PDF" },
              { v: "docx",         l: "Word" },
              { v: "png-square",   l: "PNG · square" },
              { v: "png-portrait", l: "PNG · portrait" },
            ].map(o => (
              <label key={o.v} className={`dl-radio${format === o.v ? " active" : ""}`}>
                <input type="radio" name="format" value={o.v} checked={format === o.v} onChange={() => setFormat(o.v)} />
                <span>{o.l}</span>
              </label>
            ))}
          </div>

          {format !== "docx" && (<>
            <div className="dl-section-label">Style</div>
            <label className="dl-check"><input type="checkbox" checked={justify}         onChange={e => setJustify(e.target.checked)} /><span>Justify text</span></label>
            <label className="dl-check"><input type="checkbox" checked={paragraphIndent} onChange={e => setParagraphIndent(e.target.checked)} /><span>Paragraph indent</span></label>
          </>)}

          <button id="auth-submit" type="submit" disabled={busy}>
            {busy ? "preparing…" : `Download ${format === "pdf" ? "PDF" : format === "docx" ? "Word" : "PNG"}`}
          </button>
        </form>
      </div>
    </div>
  );
}
