import React, { useEffect, useRef, useState } from "react";
import "./App.css";

function App() {
  const [content, setContent] = useState("");
  const [menuVisible, setMenuVisible] = useState(true);

  const endRef = useRef(null);
  const idleTimerRef = useRef(null);
  const typingRecentlyRef = useRef(false);

  const IDLE_MS = 1200;

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
      <div id="menu" className={menuVisible ? "menu-visible" : "menu-hidden"}>
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
