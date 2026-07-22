/*
 * Client-side helper: compress an image and upload it for a canvas.
 *
 * Pasted/dropped screenshots (especially retina PNGs) routinely exceed Vercel's
 * ~4.5 MB serverless body limit and are wasteful to store/load. So before the
 * POST we decode the image, cap its longest edge at MAX_EDGE, and — when it's
 * large enough to be worth it — re-encode to WebP (which keeps alpha, so
 * screenshots with transparency survive). Small images pass through untouched.
 *
 * Returns the public blob URL plus the encoded pixel dimensions, which the
 * caller uses to place the `image` node at the right aspect ratio.
 */

/** Downscale beyond this longest-edge (px) — plenty for a canvas image. */
const MAX_EDGE = 2000;
/** Only bother re-encoding when the original is at least this big (bytes). */
const REENCODE_OVER = 1.5 * 1024 * 1024;
/** WebP quality for the re-encoded output. */
const WEBP_QUALITY = 0.85;

interface UploadResult {
  url: string;
  /** Encoded image width in px (post-downscale). */
  w: number;
  /** Encoded image height in px (post-downscale). */
  h: number;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not decode image"));
    img.src = src;
  });
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/** Compress `file` if worthwhile; return the blob to upload + its pixel size. */
async function prepare(
  file: File,
): Promise<{ blob: Blob; name: string; w: number; h: number }> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await loadImage(objectUrl);
    const natW = img.naturalWidth || 1;
    const natH = img.naturalHeight || 1;
    const longest = Math.max(natW, natH);
    const scale = longest > MAX_EDGE ? MAX_EDGE / longest : 1;

    // Nothing to gain: small file and no downscale → send the original bytes.
    if (scale === 1 && file.size <= REENCODE_OVER) {
      return { blob: file, name: file.name || "image", w: natW, h: natH };
    }

    const w = Math.max(1, Math.round(natW * scale));
    const h = Math.max(1, Math.round(natH * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return { blob: file, name: file.name || "image", w: natW, h: natH };
    ctx.drawImage(img, 0, 0, w, h);

    const webp = await canvasToBlob(canvas, "image/webp", WEBP_QUALITY);
    // Fall back to the original if the browser couldn't encode WebP.
    if (!webp) return { blob: file, name: file.name || "image", w: natW, h: natH };
    return { blob: webp, name: "image.webp", w, h };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export async function uploadCanvasImage(
  canvasId: string,
  file: File,
): Promise<UploadResult> {
  const { blob, name, w, h } = await prepare(file);

  // FormData needs a browser-set multipart boundary, so we fetch directly
  // (same convention as WorkspaceContext's upload helpers).
  const form = new FormData();
  form.append("file", blob, name);
  const res = await fetch(`/api/canvases/${canvasId}/images`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    if (res.status === 401 && typeof window !== "undefined")
      window.location.href = "/login";
    throw new Error(`${res.status}: ${await res.text().catch(() => "")}`);
  }
  const { url } = (await res.json()) as { url: string };
  return { url, w, h };
}
