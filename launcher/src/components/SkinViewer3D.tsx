import { useEffect, useRef, useState } from "react";
import { use, createSkinViewer } from "@daidr/minecraft-skin-renderer";
import type { SkinViewer } from "@daidr/minecraft-skin-renderer";
import { WebGLRendererPlugin } from "@daidr/minecraft-skin-renderer/webgl";
import type { SkinModel } from "../types";
import { animationsEnabled } from "../preferences";
import { useMotion } from "../motion";

use(WebGLRendererPlugin);

interface Props {
  /** data-URL PNG скина, либо null — тогда грузим встроенный дефолт (стив). */
  dataUrl: string | null;
  model: SkinModel;
  /** data-URL PNG плаща, либо null — тогда плащ не показывается. */
  capeUrl?: string | null;
  width?: number;
  height?: number;
  /**
   * Когда false — канвас скрыт (display:none) и рендер приостановлен.
   * Используется при сворачивании лаунчера или когда запущен Minecraft.
   */
  visible?: boolean;
}

const DEFAULT_SKIN =
  "https://textures.minecraft.net/texture/" +
  "1a4af718455d4aab528e7a61f86fa25e6a369d1768dcb13f7df319a713eb810b";

/** Через сколько мс бездействия мыши ставить рендер на паузу. */
const IDLE_TIMEOUT_MS = 8_000;

function isWebGLAvailable(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

/**
 * 3D-модель скина (@daidr/minecraft-skin-renderer — zero-dep, WebGL2).
 *
 * Автопауза:
 *  - Окно не в фокусе или запущен MC (visible=false) → канвас скрыт, рендер выключен
 *  - Нет движения мыши > 8 с → пауза рендера
 *  - При возврате visible/движении мыши → возобновление
 */
export default function SkinViewer3D({
  dataUrl,
  model,
  capeUrl = null,
  width = 260,
  height = 360,
  visible = true,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<SkinViewer | null>(null);
  const { animations } = useMotion();
  const [webglFailed, setWebglFailed] = useState(false);

  const visibleRef = useRef(visible);
  const idleRef = useRef(false);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Кэш для skin/cape чтобы не перезагружать одно и то же.
  const lastSkinRef = useRef<string>("");
  const lastModelRef = useRef<SkinModel>("classic");
  const lastCapeRef = useRef<string | null>(null);

  /** Запустить встроенный цикл рендера (если не на паузе и visible). */
  function startLoop() {
    const v = viewerRef.current;
    if (!v || idleRef.current || !visibleRef.current) return;
    v.startRenderLoop();
  }

  /** Остановить цикл рендера. */
  function stopLoop() {
    viewerRef.current?.stopRenderLoop();
  }

  /** Сбросить таймер бездействия. */
  function resetIdleTimer() {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    if (idleRef.current) {
      idleRef.current = false;
      startLoop();
    }
    idleTimerRef.current = setTimeout(() => {
      idleRef.current = true;
      stopLoop();
    }, IDLE_TIMEOUT_MS);
  }

  // Создаём вьюер один раз.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    if (!isWebGLAvailable()) {
      setWebglFailed(true);
      return;
    }

    let disposed = false;

    createSkinViewer({
      canvas,
      preferredBackend: "webgl",
      antialias: true,
      pixelRatio: animationsEnabled()
        ? Math.min((window.devicePixelRatio || 1) * 2, 3)
        : 1,
      enableRotate: true,
      enableZoom: false,
      autoRotate: false,
      fov: 40,
      zoom: 55,
    })
      .then((viewer) => {
        if (disposed) {
          viewer.dispose();
          return;
        }
        viewer.resize(width, height);
        viewerRef.current = viewer;
        if (visibleRef.current) startLoop();
      })
      .catch(() => setWebglFailed(true));

    return () => {
      disposed = true;
      stopLoop();
      viewerRef.current?.dispose();
      viewerRef.current = null;
    };
  }, []);

  // Скрытие/показ по пропу visible (сворачивание / запуск MC).
  useEffect(() => {
    visibleRef.current = visible;
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (visible) {
      canvas.style.removeProperty("display");
      resetIdleTimer();
      startLoop();
    } else {
      canvas.style.display = "none";
      stopLoop();
      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
    }
  }, [visible]);

  // Отслеживаем движение мыши на canvas для idle-timeout.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    function onMouseMove() {
      resetIdleTimer();
    }

    canvas.addEventListener("mousemove", onMouseMove);
    resetIdleTimer();

    return () => {
      canvas.removeEventListener("mousemove", onMouseMove);
    };
  }, []);

  // Грузим скин при изменении источника/модели.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const src = dataUrl ?? DEFAULT_SKIN;
    if (src === lastSkinRef.current && model === lastModelRef.current) return;
    lastSkinRef.current = src;
    lastModelRef.current = model;

    viewer.setSlim(model === "slim");
    viewer.setSkin(src).catch(() => {
      viewer.setSkin(DEFAULT_SKIN);
    });
  }, [dataUrl, model]);

  // Плащ.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    if (capeUrl === lastCapeRef.current) return;
    lastCapeRef.current = capeUrl;

    if (capeUrl) {
      viewer.setCape(capeUrl).catch(() => {
        viewer.setBackEquipment("none");
      });
      viewer.setBackEquipment("cape");
    } else {
      viewer.setBackEquipment("none");
    }
  }, [capeUrl]);

  // Анимация подчиняется глобальному тумблеру «Анимации».
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    if (animations) {
      viewer.playAnimation("walk", { speed: 0.6 });
    } else {
      viewer.stopAnimation();
    }
  }, [animations]);

  if (webglFailed) {
    return (
      <div
        className="skin-viewer-3d"
        style={{
          width,
          height,
          background: "var(--glass)",
          border: "1px solid var(--glass-border)",
          borderRadius: "var(--radius)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          opacity: 0.5,
          fontSize: 13,
          color: "var(--muted)",
        }}
      >
        3D unavailable
      </div>
    );
  }

  return <canvas ref={canvasRef} className="skin-viewer-3d" />;
}
