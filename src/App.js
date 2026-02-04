import React, { useEffect, useRef, useState } from "react";
import "./App.css";
import "@fontsource/eb-garamond/400.css";

import { jsPDF } from "jspdf";
import garamondTTF from "./assets/EBGaramond-Regular.ttf";

// Fetch the bundled TTF URL and convert to base64 for jsPDF
async function fetchAsBase64(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch font: ${res.status} ${res.statusText}`);
  }
  const buf = await res.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buf);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function App() {
  const [content, setContent] = useState("");
  const [menuVisible, setMenuVisible] = useState(true);

  const editorRef = useRef(null);
  const endRef = useRef(null);

  const idleTimerRef = useRef(null);
  const typingRecentlyRef = useRef(false);

  const IDLE_MS = 1200;

  function hideMenuWhileTyping() {
    typingRecentlyRef.current = true;
    setMenuVisible(false);

    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => {
      typingRecentlyRef.current = false;
      setMenuVisible(true);
    }, IDLE_MS);
  }

  async function exportToPdf() {
    const doc = new jsPDF({ unit: "pt", format: "a4" });

    // Embed EB Garamond
    const base64 = await fetchAsBase64(garamondTTF);
    doc.addFileToVFS("EBGaramond-Regular.ttf", base64);
    doc.addFont("EBGaramond-Regular.ttf", "EBGaramond", "normal");
    doc.setFont("EBGaramond", "normal");
    doc.setFontSize(14);

    const margin = 56;
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const maxWidth = pageWidth - margin * 2;
    const lineHeight = 18;

    const lines = doc.splitTextToSize(content || " ", maxWidth);

    let y = margin;
    for (const line of lines) {
      if (y > pageHeight - margin) {
        doc.addPage();
        y = margin;
        doc.setFont("EBGaramond", "normal");
        doc.setFontSize(14);
      }
      doc.text(line, margin, y);
      y += lineHeight;
    }

    const stamp = new Date().toISOString().slice(0, 19).replaceAll(":", "-");
    doc.save(`inkk-${stamp}.pdf`);
  }

  // Keep the DOM editor content in sync if `content` changes (e.g., future load/clear)
  useEffect(() => {
    if (!editorRef.current) return;
    const domText = editorRef.current.innerText ?? "";
    if (domText !== content) editorRef.current.innerText = content;
  }, [content]);

  // Auto-scroll while typing: keep the caret/end roughly centered
  useEffect(() => {
    if (!typingRecentlyRef.current) return;
    endRef.current?.scrollIntoView({ block: "center" });
  }, [content]);

  // Tap/click anywhere in the container to focus the editor (important for mobile keyboard)
  function focusEditor() {
    editorRef.current?.focus();
  }

  return (
    <>
      <div
        id="menu"
        className={menuVisible ? "menu-visible" : "menu-hidden"}
        onClick={exportToPdf}
        style={{ cursor: "pointer" }}
        title="Download PDF"
      >
        inkk.
      </div>

      <div id="text-container" onMouseDown={focusEditor} onTouchStart={focusEditor}>
        <div
          id="text"
          ref={editorRef}
          contentEditable
          suppressContentEditableWarning
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          onInput={(e) => {
            setContent(e.currentTarget.innerText);
            hideMenuWhileTyping();
          }}
          onFocus={hideMenuWhileTyping}
        />
        <span ref={endRef} />
      </div>
    </>
  );
}

export default App;
