import { useEffect, useRef, useState } from "react";

/** A split flap only moves when its displayed value changes. */
export function FlipCard({ value, className, corner, cornerSide = "start" }: { value: string; className: string; corner?: string | undefined; cornerSide?: "start" | "end" }) {
  const previous = useRef(value);
  const [fold, setFold] = useState<{ from: string; to: string } | null>(null);
  const [reduced, setReduced] = useState(false);
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches);
    const visibility = () => setVisible(!document.hidden);
    update();
    visibility();
    media.addEventListener("change", update);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      media.removeEventListener("change", update);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);
  useEffect(() => {
    const from = previous.current;
    previous.current = value;
    if (from === value || reduced || !visible || document.hidden || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setFold(null);
      return;
    }
    setFold({ from, to: value });
    const end = setTimeout(() => setFold(null), 640);
    return () => clearTimeout(end);
  }, [value, reduced, visible]);
  return <span className={`flip-card ${className}${fold ? " is-flipping" : ""}`}>
    <span className="flip-card-value">{value}</span>
    {/* Printed card label (AM/PM or seconds) stays still while the leaves fold. */}
    {corner && <span className={`flip-card-corner corner-${cornerSide}`}>{corner}</span>}
    {fold && <span className="flip-leaves" aria-hidden="true" key={fold.to}>
      <span className="flip-half flip-old-bottom"><span>{fold.from}</span></span>
      <span className="flip-half flip-fold-top"><span>{fold.from}</span></span>
      <span className="flip-half flip-fold-bottom"><span>{fold.to}</span></span>
    </span>}
  </span>;
}
