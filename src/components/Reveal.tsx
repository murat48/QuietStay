"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/*
 * A section that rises and fades in the first time it scrolls into view.
 *
 * The content is server-rendered either way, so search engines and link previews
 * read it; only opacity and position animate. The CSS drops the effect
 * entirely under prefers-reduced-motion.
 */
export function Reveal({ children, className = "" }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setShown(true);
          observer.disconnect();
        }
      },
      { rootMargin: "0px 0px -12% 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={ref} className={`reveal${shown ? " is-shown" : ""} ${className}`}>
      {children}
    </div>
  );
}
