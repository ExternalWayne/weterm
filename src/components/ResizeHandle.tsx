import { useRef, useCallback } from "react";

interface Props {
  direction: "horizontal" | "vertical";
  onResize: (delta: number) => void;
}

export default function ResizeHandle({ direction, onResize }: Props) {
  const draggingRef = useRef(false);
  const startRef = useRef(0);
  const handleRef = useRef<HTMLDivElement>(null);
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    draggingRef.current = true;
    startRef.current = direction === "vertical" ? e.clientX : e.clientY;
    const cursor = direction === "vertical" ? "col-resize" : "row-resize";
    document.body.style.cursor = cursor;
    document.body.style.userSelect = "none";
    handleRef.current?.classList.add("active");

    const onMouseMove = (ev: MouseEvent) => {
      if (!draggingRef.current) return;
      const pos = direction === "vertical" ? ev.clientX : ev.clientY;
      const delta = pos - startRef.current;
      startRef.current = pos;
      onResizeRef.current(delta);
    };

    const onMouseUp = () => {
      draggingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      handleRef.current?.classList.remove("active");
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, [direction]);

  return (
    <div
      ref={handleRef}
      className={`resize-handle ${direction}`}
      onMouseDown={onMouseDown}
    />
  );
}