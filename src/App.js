import React, { useEffect, useRef, useState } from "react";
import "./App.css";
import "@fontsource/eb-garamond/400.css";

import { jsPDF } from "jspdf";
import garamondTTF from "@fontsource/eb-garamond/files/eb-garamond-latin-400-normal.ttf";

// Convert the bundled TTF file to base64 so jsPDF can embed it
async function fetchAsBase64(url) {
  const res = await fetch(url);
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

  const endRef = useRef(null);
  const idleTimerRef = useRef(null);
  const typingRecentlyRef = useRef(false);

  const IDLE_MS = 1200;

  async function exportToPdf() {
    // A4, points (pt) units
    const doc = new jsPDF({ unit: "pt", format: "a4" });

    // Embed EB Garamond into the PDF
    const base64 = await fetchAsBase64(garamondTTF);
    doc.addFileToVFS("EBGaramond.ttf", base64);
    doc.addFont("EBGaramond.ttf", "EBGaramond", "normal");
    doc.setFont("EBGaramond", "normal");
    doc.setFontSize(14);

    const margin = 56; // ~0.8 inch
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

  useEffect(() => {
    function scheduleMenuReturn() {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      idleTimerRef.current = setTimeout(() => {
        typingRecentlyRef.current = false;
        setMenuVisible(true);
      }, IDLE_MS);
    }

    function onKeyDown(e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const key = e.key;
      const isBackspace = key === "Backspace";
      const isEnter = key === "Enter";
      const isPrintable = key.length === 1;

      if (!(isBackspace || isEnter || isPrintable)) return;

      e.preventDefault();

      // hide while typing
      typingRecentlyRef.current = true;
      setMenuVisible(false);
      scheduleMenuReturn();

      if (isBackspace) {
        setContent((prev) => prev.slice(0, -1));
        return;
      }

      if (isEnter) {
        setContent((prev) => prev + "\n");
        return;
      }

      setContent((prev) => prev + key);
    }

    window.addEventListener("keydown", onKeyDown, { passive: false });
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    };
  }, []);

  // Auto-scroll while typing: keep the cursor/end roughly centered
  useEffect(() => {
    if (!typingRecentlyRef.current) return;
    endRef.current?.scrollIntoView({ block: "center" });
  }, [content]);

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

      <div id="text-container">
        <div id="start-spacer" />
        <div id="text">
          {content}
          <span className="blinking-cursor" />
          <span ref={endRef} />
        </div>
        <div id="end-spacer" />
      </div>
    </>
  );
}

export default App;
