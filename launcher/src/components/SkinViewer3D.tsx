import { memo, useEffect, useRef, useState } from "react";
import { use, createSkinViewer, registerAnimation, BoneIndex, quatFromEuler, degToRad, easeInOutSine } from "@daidr/minecraft-skin-renderer";
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
  "data:image/png;base64," +
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAFhElEQVR4Xu1a328UVRjdR6UUKJFIKL90oa4Vs1TwgRItUvlljMYSjVIDBAzUloZkg5pIDFWJUE3UpyaQiokJSWM0PPjrwcAjT/2fPufc2TN++82dGcruTrfbOcnJ3L33u7f3nPvd2dm5LZUyMLitV8Bdm59wV5bBHRt65JNj1VTa8VYcKLi6Y72jNgCEyMlDe+Wbk/ujK9hVBlD8wJY1iQaUy+UGoq4rDODq223Auq43QItFBoB6O6wKA3ziswwYqwx0jwEU/vzWta6Mu781wMeuMYDCNZkZ+ivPRztex6HSv0ZAiHquv8eJfam8QV7cGbK6s1de2B7eBypbe9yNELGogwGMQx/0xRho57g0Kuk5ws4nd2gDwD3b1zkhELhvV5+7kvh8eHCjjAxucnEwhDHogzqOow1Ie46w88kdbtKbw1ULhQfC+rHS/Nwrf89ekvvf1+Th3Izc/64WlK/Ib5+ekv27N7oYxKIP+kbbJRgTY0Nw2nOEnU/ucCu1JUjlbevCVe0PtwLK1Wf75NcvLsif16fd9feZaZmvfSj/ztZk/uM3HRGDWPRBX5QxFsbE56znCDuf3MFUDbfBWik//aTceH9Y5s8fkeHKU048MPbKrPx19aITjzIAUxCDWPRBX4yhx9RiuT30drDzyR3RZIMVC9O2T66PDcncmdfk5qkDgbij8sfVc/LPV7Xo6+3BzUvyy+QxmQme+RGDWPRBX4zB1acBPvEdYwDTHml7brQqP02+LbfPvx79oPnx9Ggg8JB8dvjlBv5w+lX58uQBF4NY9EFfjOG2QH07UHzSc4SdT+7grzeKnr943K3otx8clCvHq3L5yB6ZHh10YsHP39onX7970BFlxCD254kTru/tj94Ir/XxaCQzgKRxdj7LjvdOLIpmpVJpoI2PYXEx9jAUPRQFbaWzZ9OZhYWFcBwwKGNLvjO0O7ra8CWjFQbYR2KyJQZQfJ2r24AgA7R49zeaRSsMsKnfzi3QtAF7KzUBB54Zd9ejw3cbqNts+/DQrJSuXfuf4+NSunVLSnfuuBsmvip580Sdo44HUQdR5L17Ifk5KZ4xtp39ySxQ4OMYALo/OjEREmVOvG5CJJ4T0vGgFq3JcXQsBbIPDbXtj2NAksCsdu8EOUlMEBmhRep40E5Ykyusx7eG2XY7RhayBGa1u7TnBFDWf5wG6LqkeMZBoC5bgTqb8soAHYN9rxkJITF5LZpl1utYGmBFq/54KCNvBA9f+P2hiTodY9ut3hh8BlCczoBEA7QYmKEN8AnThnEL+PrUU91nwNzl8Ugg61tqgM2AtPaYILv63LPWAKatR7Q2RIuzBuDqM8DV12Os3hgoLElgpgF2D2YZYL8FfLEJBtgVtgb4tojVG8OjGJDWHjOAgqwofk6L91CLSzLAZsiSDBgZGREwSSDrGTc1NdXASBCuzABSr36SATqeMSwH/bQ4a4AzQRnAdr1FrN4YKCxJYFa73iK4WgNBd7NUBuibKttdDLdJQN6EkwygSF+GLJsBvgxqMCEQlhbPGF1nV7jhBhjQd49YkgEFChQoUKBAgQIFChQoUKBAgQLNounDVbwVauXhZ95o2gBz/r/6DNAZsNiGf4BoN1pqwEIb/gWm1eDLTf2WV9O+BOXbXjJ6nU7qV+m+/yewZwfLjUc1IKndidLnBDz9pRG6XZ8krSQD0tpjBmhxMCGtvSsNaPX5f7uhxfkEWgPs8bo+1PCd7fkOPjTtfHIHxfmOupZiQNbRV0cbkJbiWe3WAH2sZQ1ghvBYbEUZQNp2e7hJYVEmqNX3bRE7n9yRJTCr3aa4zwBtUscZwFPjJIGsTzpdbhB/Jr7HG7JDGdQxWyDr+Dyr3bfCOgtWhQGkE6pucK5sMqTVBvwH+QeX13iz8VkAAAAASUVORK5CYII=";

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
const SkinViewer3D = memo(function SkinViewer3D({
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

  function loadCurrent() {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const src = dataUrl ?? DEFAULT_SKIN;
    if (src !== lastSkinRef.current || model !== lastModelRef.current) {
      lastSkinRef.current = src;
      lastModelRef.current = model;
      viewer.setSlim(model === "slim");
      viewer.setSkin(src).catch(() => {
        if (src !== DEFAULT_SKIN) viewer.setSkin(DEFAULT_SKIN);
      });
    }
    if (capeUrl !== lastCapeRef.current) {
      lastCapeRef.current = capeUrl;
      if (capeUrl) {
        viewer.setCape(capeUrl).catch(() => {
          viewer.setBackEquipment("none");
        });
        viewer.setBackEquipment("cape");
      } else {
        viewer.setBackEquipment("none");
      }
    }
  }

  // Создаём вьюер один раз.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    if (!isWebGLAvailable()) {
      setWebglFailed(true);
      return;
    }

    registerAnimation({
      name: "float",
      duration: 5,
      loop: true,
      tracks: [
        {
          boneIndex: BoneIndex.RightArm,
          keyframes: [
            { time: 0, rotation: quatFromEuler(degToRad(0), 0, degToRad(15)) },
            { time: 0.5, rotation: quatFromEuler(degToRad(0), 0, degToRad(-15)), easing: easeInOutSine },
            { time: 1, rotation: quatFromEuler(degToRad(0), 0, degToRad(15)), easing: easeInOutSine },
          ],
        },
        {
          boneIndex: BoneIndex.LeftArm,
          keyframes: [
            { time: 0, rotation: quatFromEuler(degToRad(0), 0, degToRad(-15)) },
            { time: 0.5, rotation: quatFromEuler(degToRad(0), 0, degToRad(15)), easing: easeInOutSine },
            { time: 1, rotation: quatFromEuler(degToRad(0), 0, degToRad(-15)), easing: easeInOutSine },
          ],
        },
      ],
    });

    let disposed = false;

    createSkinViewer({
      canvas,
      preferredBackend: "webgl",
      antialias: true,
      pixelRatio: animationsEnabled()
        ? Math.min((window.devicePixelRatio || 1) * 2, 3)
        : 1,
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
        viewer.resize(width, height);
        viewerRef.current = viewer;
        loadCurrent();
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

  // Грузим скин/плащ при изменении пропсов.
  useEffect(() => {
    loadCurrent();
  }, [dataUrl, model, capeUrl]);

  // Анимация подчиняется глобальному тумблеру «Анимации».
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    if (animations) {
      viewer.playAnimation("float");
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

  return <canvas ref={canvasRef} className="skin-viewer-3d" style={{ width, height }} />;
});

export default SkinViewer3D;
