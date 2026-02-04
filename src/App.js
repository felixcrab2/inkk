import React, { useEffect, useRef, useState } from "react";
import "./App.css";

function App() {
  const textRef = useRef(null);
  const [menuVisible, setMenuVisible] = useState(true);
  const [content, setContent] = useState("");

  // Focus the typing area on mount so you can type immediately
  useEffect(() => {
    textRef.current?.focus();
  }, []);

  function handleKeyDown(e) {
    // Hide menu on first interaction
    if (menuVisible) setMenuVisible(false);

    // Let browser shortcuts work (Cmd+C, Cmd+V, etc.)
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    if (e.key === "Backspace") {
      e.preventDefault();
      setContent((prev) => prev.slice(0, -1));
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      setContent((prev) => prev + "\n");
      return;
    }

    // Only append printable characters
    if (e.key.length === 1) {
      e.preventDefault();
      setContent((prev) => prev + e.key);
    }
  }

  return (
    <>
      {menuVisible && <div id="menu">inkk.</div>}

      <div id="text-container">
        <div
          id="text"
          ref={textRef}
          tabIndex={0}
          role="textbox"
          aria-label="Typing area"
          onKeyDown={handleKeyDown}
          onMouseDown={() => {
            // clicking back into the area refocuses it
            setTimeout(() => textRef.current?.focus(), 0);
          }}
        >
          {content}
          <span className="blinking-cursor" />
        </div>
      </div>
    </>
  );
}

export default App;
