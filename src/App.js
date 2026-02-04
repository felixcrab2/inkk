import React, { useEffect, useRef, useState } from "react";
import "./App.css";

function App() {
  const [content, setContent] = useState("");
  const [menuVisible, setMenuVisible] = useState(true);

  // When typing stops for a moment, show the menu again
  const idleTimerRef = useRef(null);
  const IDLE_MS = 1200;

  useEffect(() => {
    function scheduleMenuReturn() {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      idleTimerRef.current = setTimeout(() => {
        setMenuVisible(true);
      }, IDLE_MS);
    }

    function onKeyDown(e) {
      // Don’t interfere with normal shortcuts
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const key = e.key;

      // Only handle keys that represent "typing"
      const isBackspace = key === "Backspace";
      const isEnter = key === "Enter";
      const isPrintable = key.length === 1;

      if (!(isBackspace || isEnter || isPrintable)) return;

      // Prevent page scrolling / weird browser defaults
      e.preventDefault();

      // Hide menu while actively typing
      if (menuVisible) setMenuVisible(false);
      scheduleMenuReturn();

      if (isBackspace) {
        setContent((prev) => prev.slice(0, -1));
        return;
      }

      if (isEnter) {
        setContent((prev) => prev + "\n");
        return;
      }

      // printable character
      setContent((prev) => prev + key);
    }

    window.addEventListener("keydown", onKeyDown, { passive: false });
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    };
  }, [menuVisible]);

  return (
    <>
      <div id="menu" className={menuVisible ? "menu-visible" : "menu-hidden"}>
        inkk.
      </div>

      <div id="text-container">
        <div id="text">
          {content}
          <span className="blinking-cursor" />
        </div>
      </div>
    </>
  );
}

export default App;
