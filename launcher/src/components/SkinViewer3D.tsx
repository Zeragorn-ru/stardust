import { useEffect, useRef } from "react";
import { SkinViewer, WalkingAnimation, IdleAnimation } from "skinview3d";
import type { SkinModel } from "../types";
import { useMotion } from "../motion";

interface Props {
  /** data-URL PNG скина, либо null — тогда грузим встроенный дефолт (стив). */
  dataUrl: string | null;
  model: SkinModel;
  /** data-URL PNG плаща, либо null — тогда плащ не показывается. */
  capeUrl?: string | null;
  width?: number;
  height?: number;
}

// Минимальный валидный 64×64 скин (Стив), на случай отсутствия пользовательского.
// skinview3d сам подставит дефолт, если передать пустую строку нельзя,
// поэтому при null показываем плейсхолдерную модель через стандартный скин.
const DEFAULT_SKIN =
  "https://textures.minecraft.net/texture/" +
  "1a4af718455d4aab528e7a61f86fa25e6a369d1768dcb13f7df319a713eb810b";

/**
 * 3D-модель скина (three.js под капотом, через skinview3d).
 * Вращается мышью; при включённых анимациях персонаж «дышит»/идёт.
 */
export default function SkinViewer3D({
  dataUrl,
  model,
  capeUrl = null,
  width = 260,
  height = 360,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<SkinViewer | null>(null);
  const { animations } = useMotion();

  // Создаём вьюер один раз.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const viewer = new SkinViewer({
      canvas,
      width,
      height,
    });
    viewer.controls.enableZoom = false;
    viewer.controls.enablePan = false;
    viewer.fov = 40;
    viewer.zoom = 0.9;
    viewerRef.current = viewer;

    return () => {
      viewer.dispose();
      viewerRef.current = null;
    };
    // width/height фиксированы на маунте; смену размера тут не обрабатываем.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Грузим скин при изменении источника/модели.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const src = dataUrl ?? DEFAULT_SKIN;
    viewer
      .loadSkin(src, { model: model === "slim" ? "slim" : "default" })
      .catch(() => {
        // Битый скин — откатываемся на дефолт.
        viewer.loadSkin(DEFAULT_SKIN);
      });
  }, [dataUrl, model]);

  // Плащ: грузим либо снимаем, когда его нет.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    if (capeUrl) {
      viewer.loadCape(capeUrl).catch(() => viewer.resetCape());
    } else {
      viewer.resetCape();
    }
  }, [capeUrl]);

  // Анимация подчиняется глобальному тумблеру «Анимации».
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    if (animations) {
      const walk = new WalkingAnimation();
      walk.speed = 0.6;
      viewer.animation = walk;
    } else {
      viewer.animation = new IdleAnimation();
      viewer.animation.paused = true;
    }
  }, [animations]);

  return <canvas ref={canvasRef} className="skin-viewer-3d" />;
}
