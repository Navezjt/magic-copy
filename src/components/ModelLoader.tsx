import { Tensor } from "onnxruntime-web";
import React from "react";
import { FrameSizeContext } from "./FrameSizeContext";
import { traceOnnxMaskToSVG } from "../lib/mask_utils";
import { modelData } from "../lib/models";

const UPLOAD_IMAGE_SIZE = 1024;

export default function ModelLoader({ image }: { image: Blob }) {
  const [bitmap, setBitmap] = React.useState<ImageBitmap>();
  const [resized, setResized] = React.useState<Blob>();
  const [tensor, setTensor] = React.useState<Tensor>();

  React.useEffect(() => {
    createImageBitmap(image).then(setBitmap);
  }, [image]);

  React.useEffect(() => {
    if (!bitmap) return;
    const h = bitmap.height;
    const w = bitmap.width;
    const scale = UPLOAD_IMAGE_SIZE / Math.max(h, w);
    const canvas = new OffscreenCanvas(w * scale, h * scale),
      ctx = canvas.getContext("2d");
    if (ctx === null) {
      throw new Error("Could not get context");
    }
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    canvas.convertToBlob().then(setResized);
  }, [bitmap]);

  React.useEffect(() => {
    if (!resized) return;
    resized
      .arrayBuffer()
      .then(
        (buffer) =>
          new Promise<string>((resolve) => {
            const data = {
              action: "embeddings",
              embeddings: {
                data: Array.from(new Uint8Array(buffer)),
                type: resized.type,
              },
            };
            chrome.runtime.sendMessage(data, resolve);
          })
      )
      .then((data) => {
        const uint8arr = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
        const float32Arr = new Float32Array(uint8arr.buffer);
        return new Tensor("float32", float32Arr, [1, 256, 64, 64]);
      })
      .then(setTensor);
  }, [resized]);

  if (!tensor || !bitmap) {
    return <div>Loading...</div>;
  }

  return <Editor tensor={tensor} bitmap={bitmap} />;
}

function Editor({ tensor, bitmap }: { tensor: Tensor; bitmap: ImageBitmap }) {
  const [output, setOutput] = React.useState<Tensor>();
  const [predMasks, setPredMasks] = React.useState<Tensor[]>([]);
  const [clicks, setClicks] = React.useState<{ x: number; y: number }[]>([]);
  const [mode, setMode] = React.useState<"edit" | "preview">("edit");
  const [rendered, setRendered] = React.useState<Blob | null>(null);

  const sandboxRef = React.useRef<HTMLIFrameElement>(null);

  const uploadScale = UPLOAD_IMAGE_SIZE / Math.max(bitmap.height, bitmap.width);

  React.useEffect(() => {
    const listener = (event: MessageEvent) => {
      setOutput(event.data.output);
      setPredMasks((predMasks) => [...predMasks, event.data.mask]);
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, []);

  React.useEffect(() => {
    if (!sandboxRef.current) {
      return;
    }
    const w = bitmap.width;
    const h = bitmap.height;
    const IMAGE_SIZE = 500;
    const d = Math.min(w, h);
    let scale = IMAGE_SIZE / d;
    if (d * scale > 1333) {
      scale = 1333 / d;
    }
    const modelScale = {
      onnxScale: scale / uploadScale,
      maskWidth: w * uploadScale,
      maskHeight: h * uploadScale,
      scale: scale,
      uploadScale: uploadScale,
      width: w,
      height: h,
    };
    if (clicks.length === 0) {
      setOutput(undefined);
      setPredMasks([]);
      return;
    }
    const feeds = modelData({
      clicks: clicks.map((click) => ({
        x: click.x,
        y: click.y,
        width: null,
        height: null,
        clickType: 1,
      })),
      tensor,
      modelScale,
      last_pred_mask:
        predMasks.length > 0 ? predMasks[predMasks.length - 1] : null,
    });
    if (!feeds) {
      return;
    }
    sandboxRef.current.contentWindow?.postMessage(feeds, "*");
  }, [tensor, bitmap, clicks, sandboxRef.current]);

  return (
    <>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          flexDirection: "row",
          padding: "5px",
        }}
      >
        <iframe
          ref={sandboxRef}
          src={chrome.runtime.getURL("sandbox.html")}
          style={{ display: "none" }}
        ></iframe>
        {/* toolbar */}
        <div>
          <button onClick={() => setMode("edit")} disabled={mode === "edit"}>
            Edit
          </button>
          <button
            onClick={() => setMode("preview")}
            disabled={mode === "preview"}
          >
            Preview
          </button>
        </div>
        <div>
          <button
            onClick={() => setClicks([...clicks.slice(0, clicks.length - 1)])}
            disabled={clicks.length === 0}
          >
            Undo
          </button>
          <button
            onClick={() => {
              if (!rendered) return;
              navigator.clipboard.write([
                new ClipboardItem({
                  // The key is determined dynamically based on the blob's type.
                  [rendered.type]: rendered,
                } as any),
              ]);
            }}
            disabled={!rendered}
          >
            Copy
          </button>
          <button
            onClick={() => {
              if (!rendered) return;
              const a = document.createElement("a");
              a.href = URL.createObjectURL(rendered);
              a.download = "image.png";
              a.click();
            }}
            disabled={!rendered}
          >
            Download
          </button>
        </div>
      </div>
      <FrameSizeContext.Consumer>
        {(frame) => {
          const scaleToFit = Math.min(
            frame.width / bitmap.width,
            frame.height / bitmap.height
          );
          return (
            <Renderer
              tensor={output}
              image={bitmap}
              canvasScale={scaleToFit}
              svgScale={
                Math.max(bitmap.height, bitmap.width) / UPLOAD_IMAGE_SIZE
              }
              onMaskClick={(x, y) => {
                const w = bitmap.width;
                const h = bitmap.height;
                const IMAGE_SIZE = 500;
                const d = Math.min(w, h);
                let scale = IMAGE_SIZE / d;
                if (d * scale > 1333) {
                  scale = 1333 / d;
                }
                setClicks((clicks) => [
                  ...clicks,
                  { x: (x * scale) / scaleToFit, y: (y * scale) / scaleToFit },
                ]);
              }}
              onRenderedImage={(blob) => setRendered(blob)}
              mode={mode}
            />
          );
        }}
      </FrameSizeContext.Consumer>
    </>
  );
}

function Renderer({
  tensor,
  image,
  canvasScale,
  svgScale,
  onMaskClick,
  onRenderedImage,
  mode,
}: {
  tensor?: Tensor;
  image: ImageBitmap;
  canvasScale: number;
  svgScale: number;
  onMaskClick: (x: number, y: number) => void;
  onRenderedImage: (blob: Blob | null) => void;
  mode: "edit" | "preview";
}) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.save();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(canvasScale, 0, 0, canvasScale, 0, 0);
    ctx.drawImage(image, 0, 0);
    if (!tensor) {
      ctx.restore();
      return;
    }
    const svg = traceOnnxMaskToSVG(tensor.data, tensor.dims[1], tensor.dims[0]);
    // draw svg on canvas
    const path = new Path2D(svg);
    const scale = canvasScale * svgScale;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    if (mode === "edit") {
      ctx.fillStyle = "rgba(0, 0, 255, 0.4)";
      ctx.globalCompositeOperation = "color-dodge";
      ctx.fill(path);
    } else {
      ctx.fillStyle = "rgba(0, 0, 0, 1)";
      ctx.globalCompositeOperation = "destination-in";
      ctx.fill(path);
    }
    ctx.restore();

    // render the output
    if (mode === "edit") {
      // rerender with offscreencanvas
      const offscreen = new OffscreenCanvas(canvas.width, canvas.height);
      const offscreenCtx = offscreen.getContext("2d");
      if (!offscreenCtx) return;
      offscreenCtx.setTransform(canvasScale, 0, 0, canvasScale, 0, 0);
      offscreenCtx.drawImage(image, 0, 0);
      offscreenCtx.setTransform(scale, 0, 0, scale, 0, 0);
      offscreenCtx.fillStyle = "rgba(0, 0, 0, 1)";
      offscreenCtx.globalCompositeOperation = "destination-in";
      offscreenCtx.fill(path);
      offscreen.convertToBlob({ type: "image/png" }).then(onRenderedImage);
    } else {
      canvas.toBlob(onRenderedImage, "image/png");
    }
  }, [image, tensor, mode, canvasScale, svgScale]);

  return (
    <canvas
      ref={canvasRef}
      width={image.width * canvasScale}
      height={image.height * canvasScale}
      onClick={(e) => {
        if (mode !== "edit") return;
        const rect = e.currentTarget.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        onMaskClick(x, y);
      }}
    />
  );
}
