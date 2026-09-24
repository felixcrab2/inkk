import { useState } from "react";

export function dropCapSrc(letter, images) {
  if (!letter || !images) return null;
  const l = letter.toLowerCase();
  const list = images[l];
  return list?.length ? `/drop_caps/${l}/${list[0]}.png` : null;
}

export function DropCapAvatar({ letter, avatarData, dropCapImages, size = 36 }) {
  const [imgErr, setImgErr] = useState(false);
  const src = !imgErr ? dropCapSrc(letter, dropCapImages) : null;
  const circleStyle = {
    width: size, height: size, borderRadius: "50%", overflow: "hidden",
    flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
  };
  if (avatarData) {
    return (
      <div style={circleStyle}>
        <img src={avatarData} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      </div>
    );
  }
  if (src) {
    return (
      <div style={{ ...circleStyle, background: "#f0ece6" }}>
        <img src={src} alt={letter?.toUpperCase()} onError={() => setImgErr(true)}
          style={{ width: "72%", height: "72%", objectFit: "contain" }} />
      </div>
    );
  }
  return (
    <div style={{ ...circleStyle, background: "var(--text)", color: "var(--bg)",
      fontFamily: '"Cormorant Garamond", serif', fontSize: size * 0.44 }}>
      {(letter || "?").toUpperCase()}
    </div>
  );
}
