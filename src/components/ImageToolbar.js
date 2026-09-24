import { Trash2, AlignLeft, AlignCenter, AlignRight } from "lucide-react";

// ─── Image toolbar ───────────────────────────────────────────────────────────
// Floating controls shown when an embedded image is selected in the editor:
// width presets, alignment, and remove. Edits are written as inline width % +
// data-align on the <img>, which the book renderer reads when rendering pages.
export function ImageToolbar({ rect, width, align, onWidth, onAlign, onRemove, panelRef }) {
  const top  = Math.max(8, rect.top - 46);
  const left = rect.left + rect.width / 2;
  const Btn = ({ active, children, ...p }) => (
    <button className={`img-tb-btn${active ? " active" : ""}`} onMouseDown={e => e.preventDefault()} {...p}>{children}</button>
  );
  return (
    <div ref={panelRef} className="img-toolbar" style={{ top, left }} onMouseDown={e => e.preventDefault()}>
      <div className="img-tb-group">
        <Btn active={width <= 45}            onClick={() => onWidth(40)}>S</Btn>
        <Btn active={width > 45 && width < 100} onClick={() => onWidth(70)}>M</Btn>
        <Btn active={width >= 100}           onClick={() => onWidth(100)}>Full</Btn>
      </div>
      <span className="img-tb-sep" />
      <div className="img-tb-group">
        <Btn active={align === "left"}   onClick={() => onAlign("left")}   aria-label="Align left"><AlignLeft size={14} strokeWidth={1.75} /></Btn>
        <Btn active={align === "center"} onClick={() => onAlign("center")} aria-label="Align center"><AlignCenter size={14} strokeWidth={1.75} /></Btn>
        <Btn active={align === "right"}  onClick={() => onAlign("right")}  aria-label="Align right"><AlignRight size={14} strokeWidth={1.75} /></Btn>
      </div>
      <span className="img-tb-sep" />
      <Btn onClick={onRemove} aria-label="Remove image"><Trash2 size={14} strokeWidth={1.75} /></Btn>
    </div>
  );
}
