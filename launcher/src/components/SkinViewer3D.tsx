import { memo, useEffect, useRef, useState } from "react";
import { use, createSkinViewer, registerAnimation, BoneIndex, quatFromEuler, degToRad, easeInOutSine } from "@daidr/minecraft-skin-renderer";
import type { SkinViewer } from "@daidr/minecraft-skin-renderer";
import { WebGLRendererPlugin } from "@daidr/minecraft-skin-renderer/webgl";
import type { SkinModel } from "../types";
import { animationsEnabled } from "../preferences";
import { useMotion } from "../motion";
import { normalizeSkinForViewer } from "../skinNormalize";
import { IDLE_ANIMATIONS } from "../animations";

use(WebGLRendererPlugin);

/** Шанс переключения idle-анимации за одну проверку (мс). По умолчанию 20 % за минуту ≈ раз в 5 мин. */
const IDLE_SWITCH_CHANCE_PER_MIN = 0.2;
const IDLE_CHECK_INTERVAL_MS = 60_000;

interface Props {
  /** data-URL PNG скина, либо null — тогда грузим встроенный дефолт (стив). */
  dataUrl: string | null;
  model: SkinModel;
  /** data-URL PNG плаща, либо null — тогда плащ не показывается. */
  capeUrl?: string | null;
  width?: number;
  height?: number;
  /** Интерактивный режим для модалки: вращение мышью, сглаживание и более долгий render loop. */
  interactive?: boolean;
  /**
   * Когда false — канвас скрыт (display:none) и рендер приостановлен.
   * Используется при сворачивании лаунчера или когда запущен Minecraft.
   */
  visible?: boolean;
}

const DEFAULT_SKIN =
  "data:image/png;base64," +
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAFhElEQVR4Xu1a328UVRjdR6UUKJFIKL90oa4Vs1TwgRItUvlljMYSjVIDBAzUloZkg5pIDFWJUE3UpyaQiokJSWM0PPjrwcAjT/2fPufc2TN++82dGcruTrfbOcnJ3L33u7f3nPvd2dm5LZUyMLitV8Bdm59wV5bBHRt65JNj1VTa8VYcKLi6Y72jNgCEyMlDe+Wbk/ujK9hVBlD8wJY1iQaUy+UGoq4rDODq223Auq43QItFBoB6O6wKA3ziswwYqwx0jwEU/vzWta6Mu781wMeuMYDCNZkZ+ivPRztex6HSv0ZAiHquv8eJfam8QV7cGbK6s1de2B7eBypbe9yNELGogwGMQx/0xRho57g0Kuk5ws4nd2gDwD3b1zkhELhvV5+7kvh8eHCjjAxucnEwhDHogzqOow1Ie46w88kdbtKbw1ULhQfC+rHS/Nwrf89ekvvf1+Th3Izc/64WlK/Ib5+ekv27N7oYxKIP+kbbJRgTY0Nw2nOEnU/ucCu1JUjlbevCVe0PtwLK1Wf75NcvLsif16fd9feZaZmvfSj/ztZk/uM3HRGDWPRBX5QxFsbE56znCDuf3MFUDbfBWik//aTceH9Y5s8fkeHKU048MPbKrPx19aITjzIAUxCDWPRBX4yhx9RiuT30drDzyR3RZIMVC9O2T66PDcncmdfk5qkDgbij8sfVc/LPV7Xo6+3BzUvyy+QxmQme+RGDWPRBX4zB1acBPvEdYwDTHml7brQqP02+LbfPvx79oPnx9Ggg8JB8dvjlBv5w+lX58uQBF4NY9EFfjOG2QH07UHzSc4SdT+7grzeKnr943K3otx8clCvHq3L5yB6ZHh10YsHP39onX7970BFlxCD254kTru/tj94Ir/XxaCQzgKRxdj7LjvdOLIpmpVJpoI2PYXEx9jAUPRQFbaWzZ9OZhYWFcBwwKGNLvjO0O7ra8CWjFQbYR2KyJQZQfJ2r24AgA7R49zeaRSsMsKnfzi3QtAF7KzUBB54Zd9ejw3cbqNts+/DQrJSuXfuf4+NSunVLSnfuuBsmvip580Sdo44HUQdR5L17Ifk5KZ4xtp39ySxQ4OMYALo/OjEREmVOvG5CJJ4T0vGgFq3JcXQsBbIPDbXtj2NAksCsdu8EOUlMEBmhRep40E5Ykyusx7eG2XY7RhayBGa1u7TnBFDWf5wG6LqkeMZBoC5bgTqb8soAHYN9rxkJITF5LZpl1utYGmBFq/54KCNvBA9f+P2hiTodY9ut3hh8BlCczoBEA7QYmKEN8AnThnEL+PrUU91nwNzl8Ugg61tqgM2AtPaYILv63LPWAKatR7Q2RIuzBuDqM8DV12Os3hgoLElgpgF2D2YZYL8FfLEJBtgVtgb4tojVG8OjGJDWHjOAgqwofk6L91CLSzLAZsiSDBgZGREwSSDrGTc1NdXASBCuzABSr36SATqeMSwH/bQ4a4AzQRnAdr1FrN4YKCxJYFa73iK4WgNBd7NUBuibKttdDLdJQN6EkwygSF+GLJsBvgxqMCEQlhbPGF1nV7jhBhjQd49YkgEFChQoUKBAgQIFChQoUKBAgQLNounDVbwVauXhZ95o2gBz/r/6DNAZsNiGf4BoN1pqwEIb/gWm1eDLTf2WV9O+BOXbXjJ6nU7qV+m+/yewZwfLjUc1IKndidLnBDz9pRG6XZ8krSQD0tpjBmhxMCGtvSsNaPX5f7uhxfkEWgPs8bo+1PCd7fkOPjTtfHIHxfmOupZiQNbRV0cbkJbiWe3WAH2sZQ1ghvBYbEUZQNp2e7hJYVEmqNX3bRE7n9yRJTCr3aa4zwBtUscZwFPjJIGsTzpdbhB/Jr7HG7JDGdQxWyDr+Dyr3bfCOgtWhQGkE6pucK5sMqTVBvwH+QeX13iz8VkAAAAASUVORK5CYII=";

/** Через сколько мс бездействия ставить рендер на паузу (интерактив-режим). */
const INTERACTIVE_IDLE_TIMEOUT_MS = 3_000;

function isWebGLAvailable(): boolean {
  try {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2") || c.getContext("webgl");
    if (!gl) return false;
    // Освобождаем контекст probe-canvas, иначе он держит WebGL-слот.
    const lose = (gl as WebGLRenderingContext).getExtension("WEBGL_lose_context");
    lose?.loseContext();
    return true;
  } catch {
    return false;
  }
}

/**
 * 3D-модель скина (@daidr/minecraft-skin-renderer — zero-dep, WebGL2).
 *
 * Автопауза:
 *  - Окно не в фокусе или запущен MC (visible=false) → канвас скрыт, рендер выключен
 *  - Нет движения мыши → пауза рендера
 *  - При возврате visible/движении мыши → возобновление
 */
const SkinViewer3D = memo(function SkinViewer3D({
  dataUrl,
  model,
  capeUrl = null,
  width = 260,
  height = 360,
  interactive = false,
  visible = true,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<SkinViewer | null>(null);
  const { animations } = useMotion();
  const animationsRef = useRef(animations);
  animationsRef.current = animations;
  const [webglFailed, setWebglFailed] = useState(false);

  const visibleRef = useRef(visible);
  const focusedRef = useRef(typeof document === "undefined" ? true : document.hasFocus());
  const idleRef = useRef(false);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Hero idle-анимация: имя текущей + таймер следующего переключения.
  const heroIdleRef = useRef<string | null>(null);
  const heroIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Кэш для skin/cape чтобы не перезагружать одно и то же.
  const lastSkinRef = useRef<string>("");
  const lastModelRef = useRef<SkinModel>("classic");
  const lastCapeRef = useRef<string | null>(null);
  // Очередь загрузок скина: быстрый повторный выбор не должен дать стейл
  // (медленному) промису перезаписать уже применённый новый скин.
  const skinChainRef = useRef<Promise<void>>(Promise.resolve());

  /** Отрисовать один кадр без постоянного requestAnimationFrame. */
  function renderOnce() {
    const v = viewerRef.current;
    if (!v || !visibleRef.current || document.hidden) return;
    v.render();
  }

  /** Запустить встроенный цикл рендера (если не на паузе и visible). */
  function startLoop() {
    const v = viewerRef.current;
    if (!v || idleRef.current || !visibleRef.current || !focusedRef.current || document.hidden) return;
    // Hero (не-интерактив) крутим только при включённых анимациях; иначе один кадр.
    if (!interactive && !animationsRef.current) {
      renderOnce();
      return;
    }
    v.startRenderLoop();
  }

  /** Остановить цикл рендера. */
  function stopLoop() {
    viewerRef.current?.stopRenderLoop();
  }

  /** Сбросить таймер бездействия. */
  function resetIdleTimer() {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    // Hero (главный экран): render loop живёт, пока модель видима — float-анимация
    // не должна замирать на середине движения. Idle-пауза (stopLoop) — только для
    // интерактивного режима (модалка), где пользователь перестал крутить мышью.
    if (!interactive) {
      if (idleRef.current) {
        idleRef.current = false;
      }
      startLoop();
      return;
    }
    if (idleRef.current) {
      idleRef.current = false;
    }
    startLoop();
    idleTimerRef.current = setTimeout(() => {
      idleRef.current = true;
      stopLoop();
    }, INTERACTIVE_IDLE_TIMEOUT_MS);
  }

  function loadCurrent() {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const src = dataUrl ?? DEFAULT_SKIN;
    if (src !== lastSkinRef.current || model !== lastModelRef.current) {
      lastSkinRef.current = src;
      lastModelRef.current = model;
      viewer.setSlim(model === "slim");
      const wanted = src;
      const wantedModel = model;
      skinChainRef.current = skinChainRef.current
        .catch(() => undefined)
        .then(async () => {
          // Пока грузилось — скин уже сменился: устаревшую задачу пропускаем.
          if (lastSkinRef.current !== wanted || lastModelRef.current !== wantedModel) return;
          try {
            const normalized = await normalizeSkinForViewer(wanted);
            if (lastSkinRef.current !== wanted) return;
            await viewer.setSkin(normalized);
          } catch {
            if (lastSkinRef.current !== wanted) return;
            try {
              await viewer.setSkin(wanted);
            } catch {
              if (wanted !== DEFAULT_SKIN && lastSkinRef.current === wanted) {
                await viewer.setSkin(DEFAULT_SKIN).catch(() => undefined);
              }
            }
          } finally {
            renderOnce();
          }
        });
    }
    if (capeUrl !== lastCapeRef.current) {
      lastCapeRef.current = capeUrl;
      if (capeUrl) {
        viewer.setCape(capeUrl).catch(() => {
          viewer.setBackEquipment("none");
        }).finally(renderOnce);
        viewer.setBackEquipment("cape");
      } else {
        viewer.setBackEquipment("none");
        renderOnce();
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
            { time: 0, rotation: quatFromEuler(degToRad(0), 0, degToRad(-8)) },
            { time: 0.5, rotation: quatFromEuler(degToRad(0), 0, degToRad(0)), easing: easeInOutSine },
            { time: 1, rotation: quatFromEuler(degToRad(0), 0, degToRad(-8)), easing: easeInOutSine },
          ],
        },
        {
          boneIndex: BoneIndex.LeftArm,
          keyframes: [
            { time: 0, rotation: quatFromEuler(degToRad(0), 0, degToRad(8)) },
            { time: 0.5, rotation: quatFromEuler(degToRad(0), 0, degToRad(0)), easing: easeInOutSine },
            { time: 1, rotation: quatFromEuler(degToRad(0), 0, degToRad(8)), easing: easeInOutSine },
          ],
        },
      ],
    });

    // Регистрируем все idle-анимации один раз при монтировании.
    for (const anim of IDLE_ANIMATIONS) {
      registerAnimation(anim);
    }

    let disposed = false;

    function onContextLost(e: Event) {
      e.preventDefault();
      stopLoop();
    }
    function onContextRestored() {
      const v = viewerRef.current;
      if (v && visibleRef.current) {
        v.resize(width, height);
        startLoop();
      }
    }

    canvas.addEventListener("webglcontextlost", onContextLost);
    canvas.addEventListener("webglcontextrestored", onContextRestored);

    createSkinViewer({
      canvas,
      preferredBackend: "webgl",
      antialias: interactive,
      pixelRatio: animationsEnabled()
        ? Math.min(window.devicePixelRatio || 1, interactive ? 1.5 : 1)
        : 1,
      fov: 55,
      // Вращение мышью доступно и на главном экране: авто-вращение само
      // приостанавливается на время перетаскивания (isDragging) в движке.
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
        if (interactive) {
          if (animations) viewer.playAnimation("float");
        } else if (animations) {
          // Hero: случайные idle-анимации вместо фиксированного float.
          startHeroIdleLoop();
        }
        if (visibleRef.current) startLoop();
        resetIdleTimer();
      })
      .catch(() => setWebglFailed(true));

    return () => {
      disposed = true;
      canvas.removeEventListener("webglcontextlost", onContextLost);
      canvas.removeEventListener("webglcontextrestored", onContextRestored);
      stopHeroIdleLoop();
      stopLoop();
      viewerRef.current?.dispose();
      viewerRef.current = null;
    };
  }, []);

  // Пауза при скрытии вкладки/webview или потере фокуса окна.
  useEffect(() => {
    function updateFocusState() {
      focusedRef.current = document.hasFocus();
      if (focusedRef.current && !document.hidden) {
        idleRef.current = false;
        startLoop();
        resetIdleTimer();
      } else {
        stopLoop();
      }
    }

    window.addEventListener("focus", updateFocusState);
    window.addEventListener("blur", updateFocusState);
    document.addEventListener("visibilitychange", updateFocusState);

    return () => {
      window.removeEventListener("focus", updateFocusState);
      window.removeEventListener("blur", updateFocusState);
      document.removeEventListener("visibilitychange", updateFocusState);
    };
  }, [interactive]);

  // Скрытие/показ по пропу visible (сворачивание / запуск MC).
  useEffect(() => {
    visibleRef.current = visible;
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (visible) {
      canvas.style.removeProperty("display");
      // Пересчитываем размер после可能出现 display:none, иначе WebGL-буфер
      // может оказаться 0×0 и отрисовка покажет белый квадрат.
      const v = viewerRef.current;
      if (v) {
        v.resize(width, height);
        startLoop();
      }
      resetIdleTimer();
    } else {
      canvas.style.display = "none";
      stopLoop();
      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
    }
  }, [visible]);

  // Отслеживаем активность на canvas для idle-timeout (throttled).
  // Работает и на hero: перетаскивание модели будит render loop, чтобы
  // поворот применялся, а после отпускания loop снова засыпает по idle.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let lastMove = 0;
    function onActivity() {
      const now = Date.now();
      if (now - lastMove < 120) return; // throttle
      lastMove = now;
      resetIdleTimer();
    }

    canvas.addEventListener("pointerdown", onActivity);
    canvas.addEventListener("pointermove", onActivity);
    canvas.addEventListener("touchstart", onActivity, { passive: true });
    canvas.addEventListener("wheel", onActivity, { passive: true });
    resetIdleTimer();

    return () => {
      canvas.removeEventListener("pointerdown", onActivity);
      canvas.removeEventListener("pointermove", onActivity);
      canvas.removeEventListener("touchstart", onActivity);
      canvas.removeEventListener("wheel", onActivity);
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
    if (interactive) {
      // Интерактивный режим (модалка): фиксированный float, вращение мышью.
      // Idle-ротация hero здесь не нужна.
      stopHeroIdleLoop();
      viewer.setAutoRotate(false);
      if (animations) viewer.playAnimation("float");
      else viewer.stopAnimation();
    } else {
      // Hero (главный экран): без autoRotate, случайные idle-анимации.
      viewer.setAutoRotate(false);
      if (animations) {
        startHeroIdleLoop();
      } else {
        stopHeroIdleLoop();
        viewer.stopAnimation();
        renderOnce();
      }
    }
  }, [animations, interactive]);

  /**
   * Hero idle-цикл: играет случайную анимацию из IDLE_ANIMATIONS, затем
   * раз в IDLE_CHECK_INTERVAL_MS (60 с) бросает кубик с шансом IDLE_SWITCH_CHANCE_PER_MIN
   * (по умолчанию 20 % в минуту ≈ в среднем раз в 5 минут). При «удаче» — переключает
   * на другую случайную анимацию и перезапускает таймер.
   * Таймер гасится при unmount / смене interactive / выключении анимаций.
   */
  function startHeroIdleLoop() {
    stopHeroIdleLoop();
    const viewer = viewerRef.current;
    if (!viewer) return;
    const pick = IDLE_ANIMATIONS[Math.floor(Math.random() * IDLE_ANIMATIONS.length)];
    viewer.playAnimation(pick.name);
    heroIdleRef.current = pick.name;
    startLoop();
    scheduleHeroCheck();
  }

  function scheduleHeroCheck() {
    if (heroIdleTimerRef.current) clearTimeout(heroIdleTimerRef.current);
    heroIdleTimerRef.current = setTimeout(() => {
      const viewer = viewerRef.current;
      // Вьюер мог быть уничтожен (unmount) или анимации выключены — выходим.
      if (!viewer || !animationsRef.current) return;

      // Бросок кубика: IDLE_SWITCH_CHANCE_PER_MIN шанс за каждый интервал
      const shouldSwitch = Math.random() < IDLE_SWITCH_CHANCE_PER_MIN;
      if (shouldSwitch) {
        const current = heroIdleRef.current;
        const pool = IDLE_ANIMATIONS.filter((a) => a.name !== current);
        const pick = pool[Math.floor(Math.random() * pool.length)] ?? IDLE_ANIMATIONS[0];
        viewer.playAnimation(pick.name);
        heroIdleRef.current = pick.name;
        startLoop();
      }
      // Даже без переключения — планируем следующую проверку через тот же интервал
      scheduleHeroCheck();
    }, IDLE_CHECK_INTERVAL_MS);
  }

  function stopHeroIdleLoop() {
    if (heroIdleTimerRef.current) {
      clearTimeout(heroIdleTimerRef.current);
      heroIdleTimerRef.current = null;
    }
    heroIdleRef.current = null;
  }

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

  return (
    <canvas
      ref={canvasRef}
      className="skin-viewer-3d"
      style={{ width, height }}
    />
  );
});

export default SkinViewer3D;
