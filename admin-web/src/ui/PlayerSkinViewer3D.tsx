import { useEffect, useRef, useState } from "react";
import { use, createSkinViewer } from "@daidr/minecraft-skin-renderer";
import type { SkinViewer } from "@daidr/minecraft-skin-renderer";
import { WebGLRendererPlugin } from "@daidr/minecraft-skin-renderer/webgl";
import type { SkinModel } from "../api";

use(WebGLRendererPlugin);

interface Props {
  src: string;
  model: SkinModel;
}

export default function PlayerSkinViewer3D({ src, model }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<SkinViewer | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let disposed = false;
    createSkinViewer({
      canvas,
      preferredBackend: "webgl",
      antialias: false,
      pixelRatio: Math.min(window.devicePixelRatio || 1, 1.5),
      fov: 55,
      enableRotate: true,
      enableZoom: false,
      autoRotate: false,
    })
      .then((viewer) => {
        if (disposed) {
          viewer.dispose();
          return;
        }
        viewerRef.current = viewer;
        viewer.resize(240, 320);
        viewer.setSlim(model === "slim");
        return viewer.setSkin(src).then(() => viewer.render());
      })
      .catch(() => setUnavailable(true));

    return () => {
      disposed = true;
      viewerRef.current?.dispose();
      viewerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    viewer.setSlim(model === "slim");
    void viewer.setSkin(src).then(() => viewer.render()).catch(() => setUnavailable(true));
  }, [model, src]);

  if (unavailable) {
    return <div className="pc-skin-viewer pc-skin-viewer--fallback">3D-превью недоступно</div>;
  }

  return <canvas ref={canvasRef} className="pc-skin-viewer" aria-label="3D-модель скина" />;
}
