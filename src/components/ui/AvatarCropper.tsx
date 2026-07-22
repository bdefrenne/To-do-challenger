"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** Square-crop an image before upload: drag to reposition, slide to zoom.
 *  Exports a 512×512 JPEG via <canvas> — no third-party library.
 *  Shared by the profile picture and board picture flows. */
export function AvatarCropper({
  file,
  onCancel,
  onDone,
}: {
  file: File;
  onCancel: () => void;
  onDone: (blob: Blob) => void;
}) {
  const V = 256; // viewport (on-screen crop frame) size
  const OUT = 512; // exported square size
  const imgRef = useRef<HTMLImageElement>(null);
  const [src, setSrc] = useState<string>("");
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null);

  // Object URL for the picked file; revoked on unmount.
  useEffect(() => {
    const url = URL.createObjectURL(file);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot object-URL for the picked file; revoked on cleanup
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const cover = nat ? Math.max(V / nat.w, V / nat.h) : 1;
  const scale = cover * zoom;

  const clamp = useCallback(
    (o: { x: number; y: number }) => {
      if (!nat) return o;
      const dw = nat.w * scale;
      const dh = nat.h * scale;
      return {
        x: Math.min(0, Math.max(V - dw, o.x)),
        y: Math.min(0, Math.max(V - dh, o.y)),
      };
    },
    [nat, scale],
  );

  function onLoad() {
    const img = imgRef.current;
    if (!img) return;
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const c = Math.max(V / w, V / h);
    setNat({ w, h });
    // Center the image in the frame.
    setOffset({ x: (V - w * c) / 2, y: (V - h * c) / 2 });
    setZoom(1);
  }

  function onZoom(z: number) {
    if (!nat) return setZoom(z);
    const sOld = cover * zoom;
    const sNew = cover * z;
    // Keep the frame's center point pinned while zooming.
    const cx = (V / 2 - offset.x) / sOld;
    const cy = (V / 2 - offset.y) / sOld;
    setZoom(z);
    setOffset(clamp({ x: V / 2 - cx * sNew, y: V / 2 - cy * sNew }));
  }

  function exportSquare() {
    const img = imgRef.current;
    if (!img || !nat) return;
    const sx = -offset.x / scale;
    const sy = -offset.y / scale;
    const sSize = V / scale;
    const canvas = document.createElement("canvas");
    canvas.width = OUT;
    canvas.height = OUT;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(img, sx, sy, sSize, sSize, 0, 0, OUT, OUT);
    canvas.toBlob((b) => b && onDone(b), "image/jpeg", 0.9);
  }

  return (
    <div
      className="fixed inset-0 z-[210] flex items-center justify-center bg-slate-900/40 p-6 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-sm rounded-xl border border-border bg-surface p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-3 text-sm font-semibold">Crop your photo</h3>

        <div
          className="relative mx-auto touch-none overflow-hidden rounded-full border border-border bg-surface-2"
          style={{ width: V, height: V, cursor: "grab" }}
          onPointerDown={(e) => {
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
            drag.current = { px: e.clientX, py: e.clientY, ox: offset.x, oy: offset.y };
          }}
          onPointerMove={(e) => {
            if (!drag.current) return;
            setOffset(
              clamp({
                x: drag.current.ox + (e.clientX - drag.current.px),
                y: drag.current.oy + (e.clientY - drag.current.py),
              }),
            );
          }}
          onPointerUp={() => (drag.current = null)}
        >
          {src ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              ref={imgRef}
              src={src}
              alt="Crop preview"
              onLoad={onLoad}
              draggable={false}
              className="max-w-none select-none"
              style={{
                position: "absolute",
                left: offset.x,
                top: offset.y,
                width: nat ? nat.w * scale : undefined,
                height: nat ? nat.h * scale : undefined,
              }}
            />
          ) : null}
        </div>

        <label className="mt-4 block">
          <span className="mb-1 block text-xs text-muted">Zoom</span>
          <input
            type="range"
            min={1}
            max={3}
            step={0.01}
            value={zoom}
            onChange={(e) => onZoom(Number(e.target.value))}
            className="w-full"
          />
        </label>

        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-lg border border-border px-3 py-2 text-sm font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg"
          >
            Cancel
          </button>
          <button
            onClick={exportSquare}
            disabled={!nat}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            Save photo
          </button>
        </div>
      </div>
    </div>
  );
}
