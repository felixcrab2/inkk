import React, { useCallback, useEffect, useRef, useState } from "react";
import "./App.css";
import "@fontsource/eb-garamond/400.css";

import { jsPDF } from "jspdf";
import garamondTTF from "./assets/EBGaramond-Regular.ttf";

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

function isMobileDevice() {
  return (
    typeof navigator !== "undefined" &&
    (navigator.maxTouchPoints > 0 || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent))
  );
}

function App() {
  // NOTE: this is now just a debounced snapshot (for PDF + React)
  const [contentSnapshot, setContentSnapshot] = useState("");
  const [menuVisible, setMenuVisible] = useState(true);

  const editorRef = useRef(null);
  const containerRef = useRef(null);

  const isMobileRef = useRef(false);

  // fast “truth”
  const contentRef = useRef("");

  // timers / throttles
  const idleTimerRef = useRef(null);
  const syncTimerRef = useRef(null);
  const scrollRafRef = useRef(null);
  const lastScrollTsRef = useRef(0);

  const IDLE_MS = 1200;

  const scheduleMenuReturn = useCallback(() => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => {
      setMenuVisible(true);
    }, IDLE_MS);
  }, []);

  const markTyping = useCallback(() => {
    setMenuVisible(false);
    scheduleMenuReturn();
  }, [scheduleMenuReturn]);

  // Debounce syncing DOM text → React state (prevents lag)
  const debouncedSyncSnapshot = useCallback(() => {
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    syncTimerRef.current = setTimeout(() => {
      setContentSnapshot(contentRef.current);
    }, 250);
  }, []);

  // Throttled auto-scroll (mobile especially)
  const scheduleScroll = useCallback(() => {
    const now = Date.now();
    const minGap = isMobileRef.current ? 120 : 16; // mobile: less aggressive
    if (now - lastScrollTsRef.current < minGap) return;

    lastScrollTsRef.current = now;

    if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current);
    scrollRafRef.current = requestAnimationFrame(() => {
      const el = containerRef.current;
      if (!el) return;
      // keep the caret roughly in view by nudging towards bottom
      el.scrollTop = el.scrollHeight;
    });
  }, []);

  const focusEditor = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    // prevent iOS jumpiness where supported
    try {
      el.focus({ preventScroll: true });
    } catch {
      el.focus();
    }
  }, []);

  const onInput = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;

    // Read text directly from DOM (fast)
    contentRef.current = el.innerText;

    markTyping();
    debouncedSyncSnapshot();
    scheduleScroll();
  }, [markTyping, debouncedSyncSnapshot, scheduleScroll]);

  async function exportToPdf() {
    // Always use the ref (most up-to-date), not the debounced snapshot
    const text = contentRef.current || "";

    const doc = new jsPDF({ unit: "pt", format: "a4" });

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

    const lines = doc.splitTextToSize(text || " ", maxWidth);

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
    isMobileRef.current = isMobileDevice();

    // Ensure editor starts empty and ready
    if (editorRef.current && editorRef.current.innerText !== contentRef.current) {
      editorRef.current.innerText = contentRef.current;
    }

    return () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
      if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current);
    };
  }, []);

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

      <div
        id="text-container"
        ref={containerRef}
        onClick={focusEditor}
      >
        <div
          id="text"
          ref={editorRef}
          contentEditable
          suppressContentEditableWarning
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          onInput={onInput}
        />
      </div>
    </>
  );
}

export default App;
