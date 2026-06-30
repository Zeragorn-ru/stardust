import { useEffect, useRef, useState } from "react";
import { SkinViewer, WalkingAnimation, IdleAnimation } from "skinview3d";
import type { SkinModel } from "../types";
import { animationsEnabled } from "../preferences";
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
 * 3D-модель скина (three.js под капотом, через skinview3d).
 * Вращается мышью; при включённых анимациях персонаж «дышит»/идёт.
 *
 * Автопауза:
 *  - Окно не в фокусе → пауза рендера
 *  - Нет движения мыши > 8 с → пауза рендера
 *  - При возврате фокуса/движении мыши → возобновление
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
  const [webglFailed, setWebglFailed] = useState(false);

  // Флаги паузы.
  const pausedRef = useRef(false);       // окно не в фокусе
  const idleRef = useRef(false);         // нет активности > IDLE_TIMEOUT_MS
  const rafRef = useRef<number>(0);      // handle requestAnimationFrame
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Запустить цикл рендера (если не запущен и нет паузы). */
  function startLoop() {
    if (rafRef.current) return; // уже работает
    const viewer = viewerRef.current;
    if (!viewer) return;

    function frame() {
      if (!viewerRef.current) return;
      if (pausedRef.current || idleRef.current) {
        rafRef.current = 0;
        return;
      }
      viewerRef.current.render();
      rafRef.current = requestAnimationFrame(frame);
    }
    rafRef.current = requestAnimationFrame(frame);
  }

  /** Остановить цикл рендера. */
  function stopLoop() {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
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

    let viewer: SkinViewer;
    try {
      viewer = new SkinViewer({ canvas, width, height });
    } catch {
      setWebglFailed(true);
      return;
    }

    viewer.controls.enableZoom = false;
    viewer.controls.enablePan = false;
    viewer.fov = 40;
    viewer.zoom = 0.9;
    // Супер-сэмплинг: рендерим в 2× плотности и даунскейлим. Кап в 3 для HiDPI.
    // При выключенных анимациях — без супер-сэмплинга (1×) для экономии GPU.
    viewer.pixelRatio = animationsEnabled()
      ? Math.min((window.devicePixelRatio || 1) * 2, 3)
      : 1;
    viewerRef.current = viewer;

    // Первый кадр.
    viewer.render();

    return () => {
      stopLoop();
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      viewer.dispose();
      viewerRef.current = null;
    };
  }, []);

  // Слушаем фокус/потерю фокуса окна Tauri.
  useEffect(() => {
    let unlistenFn: (() => void) | null = null;

    async function setup() {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();

        // onFocusChanged возвращает unlisten функцию.
        const unlisten = await win.onFocusChanged(({ payload: focused }) => {
          pausedRef.current = !focused;
          if (focused) {
            resetIdleTimer();
            startLoop();
          } else {
            stopLoop();
          }
        });
        unlistenFn = unlisten;
      } catch {
        // Не Tauri окно — пропускаем.
      }
    }
    void setup();

    return () => {
      unlistenFn?.();
    };
  }, []);

  // Отслеживаем движение мыши на canvas для idle-timeout.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    function onMouseMove() {
      resetIdleTimer();
    }

    canvas.addEventListener("mousemove", onMouseMove);
    // Инициализируем таймер сразу.
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
    viewer
      .loadSkin(src, { model: model === "slim" ? "slim" : "default" })
      .catch(() => {
        viewer.loadSkin(DEFAULT_SKIN);
      });
  }, [dataUrl, model]);

  // Плащ.
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
    // Перерисовать после смены анимации.
    if (!pausedRef.current && !idleRef.current) {
      viewer.render();
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
