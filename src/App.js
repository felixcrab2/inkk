import React, { useEffect, useRef, useState } from "react";
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
  const [content, setContent] = useState("");
  const [menuVisible, setMenuVisible] = useState(true);

  const endRef = useRef(null);
  const idleTimerRef = useRef(null);
  const typingRecentlyRef = useRef(false);

  const mobileInputRef = useRef(null);
  const isMobileRef = useRef(false);

  const IDLE_MS = 1200;

  function scheduleMenuReturn() {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => {
      typingRecentlyRef.current = false;
      setMenuVisible(true);
    }, IDLE_MS);
  }

  function markTyping() {
    typingRecentlyRef.current = true;
    setMenuVisible(false);
    scheduleMenuReturn();
  }

  async function exportToPdf() {
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
    isMobileRef.current = isMobileDevice();

    function onKeyDown(e) {
      // Desktop only: keep your exact behaviour
      if (isMobileRef.current) return;

      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const key = e.key;
      const isBackspace = key === "Backspace";
      const isEnter = key === "Enter";
      const isPrintable = key.length === 1;

      if (!(isBackspace || isEnter || isPrintable)) return;

      e.preventDefault();
      markTyping();

      if (isBackspace) return setContent((prev) => prev.slice(0, -1));
      if (isEnter) return setContent((prev) => prev + "\n");
      setContent((prev) => prev + key);
    }

    window.addEventListener("keydown", onKeyDown, { passive: false });
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!typingRecentlyRef.current) return;
    endRef.current?.scrollIntoView({ block: isMobileRef.current ? "end" : "center" });
  }, [content]);

  function focusMobileKeyboard() {
    if (!isMobileRef.current) return;
    const el = mobileInputRef.current;
    if (!el) return;

    // don't refocus if already focused (prevents jitter)
    if (document.activeElement === el) return;

    // preventScroll reduces iOS jumpiness; harmless where unsupported
    try {
      el.focus({ preventScroll: true });
    } catch {
      el.focus();
    }
  }

  function handleMobileKeyDown(e) {
    if (!isMobileRef.current) return;

    const key = e.key;
    markTyping();

    if (key === "Backspace") {
      e.preventDefault();
      setContent((prev) => prev.slice(0, -1));
      return;
    }

    if (key === "Enter") {
      e.preventDefault();
      setContent((prev) => prev + "\n");
      return;
    }
  }

  function handleMobileChange(e) {
    if (!isMobileRef.current) return;

    const val = e.target.value;
    if (!val) return;

    markTyping();
    setContent((prev) => prev + val);

    // clear so next keystroke is easy to detect
    e.target.value = "";
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

      {/* Invisible on-screen input to trigger mobile keyboard (avoid off-screen iOS jitter) */}
      <textarea
        id="mobile-input"
        ref={mobileInputRef}
        inputMode="text"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        onKeyDown={handleMobileKeyDown}
        onChange={handleMobileChange}
      />

      <div id="text-container" onClick={focusMobileKeyboard}>
        <div id="text">
          {content}
          <span className="blinking-cursor" />
          <span ref={endRef} />
        </div>
      </div>
    </>
  );
}

export default App;
