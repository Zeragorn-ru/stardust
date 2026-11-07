import { memo, useEffect, useRef, useState } from "react";
import { use, createSkinViewer, registerAnimation, BoneIndex, quatFromEuler, degToRad, easeInOutSine } from "@daidr/minecraft-skin-renderer";
import type { SkinViewer } from "@daidr/minecraft-skin-renderer";
import { WebGLRendererPlugin } from "@daidr/minecraft-skin-renderer/webgl";
import type { SkinModel } from "../types";
import { animationsEnabled } from "../preferences";
import { useMotion } from "../motion";
import { normalizeSkinForViewer } from "../skinNormalize";
import { IDLE_ANIMATIONS, SLIM_IDLE_ANIMATIONS, SHOW_ANIMATIONS, SLIM_SHOW_ANIMATIONS, animationNameForModel } from "../animations";

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
  /** Ручное управление анимацией в отдельном отладочном окне. */
  debugPlayback?: { name: string | null; sequence: number; paused: boolean; speed: number };
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
  debugPlayback,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<SkinViewer | null>(null);
  const { animations } = useMotion();
  const animationsRef = useRef(animations);
  animationsRef.current = animations;
  const debugRef = useRef(debugPlayback);
  debugRef.current = debugPlayback;
  const [webglFailed, setWebglFailed] = useState(false);

  const visibleRef = useRef(visible);
  const focusedRef = useRef(typeof document === "undefined" ? true : document.hasFocus());
  const idleRef = useRef(false);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Hero idle-анимация: имя текущей + таймер следующего переключения.
  const heroIdleRef = useRef<string | null>(null);
  const heroIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heroShowPlayedRef = useRef(false);
  const heroShowActiveRef = useRef(false);
  const heroShowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heroShowGenerationRef = useRef(0);
  const skinReadyRef = useRef(false);

  // Кэш для skin/cape чтобы не перезагружать одно и то же.
  const lastSkinRef = useRef<string>("");
  const lastModelRef = useRef<SkinModel>("classic");
  const lastAppliedModelRef = useRef<SkinModel | null>(null);
  const lastCapeRef = useRef<string | null>(null);
  const capeGenerationRef = useRef(0);
  const capeChainRef = useRef<Promise<void>>(Promise.resolve());
  // Очередь загрузок скина: быстрый повторный выбор не должен дать стейл
  // (медленному) промису перезаписать уже применённый новый скин.
  const skinChainRef = useRef<Promise<void>>(Promise.resolve());
  // Жизненный цикл вьюера: асинхронные загрузки должны перестать трогать его
  // и refs сразу после cleanup, даже если их промисы завершатся позже.
  const lifecycleGenerationRef = useRef(0);
  const viewerActiveRef = useRef(false);

  function isViewerActive(viewer: SkinViewer, generation: number): boolean {
    return viewerActiveRef.current && lifecycleGenerationRef.current === generation && viewerRef.current === viewer;
  }

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
    if (!debugRef.current && !interactive && !animationsRef.current) {
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
    if (!interactive || debugRef.current) {
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
    const lifecycleGeneration = lifecycleGenerationRef.current;
    if (!viewer || !viewerActiveRef.current) return;
    const src = dataUrl ?? DEFAULT_SKIN;
    if (src !== lastSkinRef.current || model !== lastModelRef.current) {
      lastSkinRef.current = src;
      lastModelRef.current = model;
      skinReadyRef.current = false;
      heroShowPlayedRef.current = false;
      heroShowGenerationRef.current += 1;
      if (heroShowTimerRef.current) {
        clearTimeout(heroShowTimerRef.current);
        heroShowTimerRef.current = null;
      }
      const modelChanged = model !== lastAppliedModelRef.current;
      viewer.setSlim(model === "slim");
      lastAppliedModelRef.current = model;
      // setSlim пересоздаёт скелет: заново применяем вариант для новой модели.
      if (modelChanged) {
        const playback = debugRef.current;
        const name = playback ? playback.name : heroIdleRef.current;
        if (name) {
          viewer.playAnimation(animationNameForModel(name, model));
          if (playback) {
            viewer.setAnimationSpeed(playback.speed);
            if (playback.paused) viewer.pauseAnimation();
          }
        }
      }
      const wanted = src;
      const wantedModel = model;
      skinChainRef.current = skinChainRef.current
        .catch(() => undefined)
        .then(async () => {
          // Пока грузилось — скин уже сменился: устаревшую задачу пропускаем.
          if (!isViewerActive(viewer, lifecycleGeneration) || lastSkinRef.current !== wanted || lastModelRef.current !== wantedModel) return;
          try {
            const normalized = await normalizeSkinForViewer(wanted);
            if (!isViewerActive(viewer, lifecycleGeneration) || lastSkinRef.current !== wanted || lastModelRef.current !== wantedModel) return;
            await viewer.setSkin(normalized);
          } catch {
            if (!isViewerActive(viewer, lifecycleGeneration) || lastSkinRef.current !== wanted || lastModelRef.current !== wantedModel) return;
            try {
              await viewer.setSkin(wanted);
            } catch {
              if (isViewerActive(viewer, lifecycleGeneration) && wanted !== DEFAULT_SKIN && lastSkinRef.current === wanted && lastModelRef.current === wantedModel) {
                await viewer.setSkin(DEFAULT_SKIN).catch(() => undefined);
              }
            }
          } finally {
            if (!isViewerActive(viewer, lifecycleGeneration)) return;
            if (lastSkinRef.current === wanted && lastModelRef.current === wantedModel) {
              skinReadyRef.current = true;
            }
            renderOnce();
            if (lastSkinRef.current === wanted && lastModelRef.current === wantedModel && animationsRef.current && !debugRef.current && !interactive) {
              startHeroShowThenIdle();
            }
          }
        });
    }
    if (capeUrl !== lastCapeRef.current) {
      lastCapeRef.current = capeUrl;
      const capeGeneration = ++capeGenerationRef.current;
      const wantedCape = capeUrl;
      capeChainRef.current = capeChainRef.current
        .catch(() => undefined)
        .then(async () => {
          if (!isViewerActive(viewer, lifecycleGeneration) || capeGeneration !== capeGenerationRef.current || lastCapeRef.current !== wantedCape) return;
          if (wantedCape) {
            try {
              await viewer.setCape(wantedCape);
              // Проверяем поколение после await: setCape может завершиться уже
              // после выбора нового плаща и не должен менять состояние поверх него.
              if (!isViewerActive(viewer, lifecycleGeneration) || capeGeneration !== capeGenerationRef.current || lastCapeRef.current !== wantedCape) return;
              viewer.setBackEquipment("cape");
            } catch {
              if (isViewerActive(viewer, lifecycleGeneration) && capeGeneration === capeGenerationRef.current && lastCapeRef.current === wantedCape) {
                viewer.setBackEquipment("none");
              }
            }
          } else {
            if (!isViewerActive(viewer, lifecycleGeneration)) return;
            viewer.setBackEquipment("none");
          }
          if (isViewerActive(viewer, lifecycleGeneration) && capeGeneration === capeGenerationRef.current && lastCapeRef.current === wantedCape) renderOnce();
        });
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
    for (const anim of [...IDLE_ANIMATIONS, ...SLIM_IDLE_ANIMATIONS, ...SHOW_ANIMATIONS, ...SLIM_SHOW_ANIMATIONS]) {
      registerAnimation(anim);
    }

    let disposed = false;
    const lifecycleGeneration = ++lifecycleGenerationRef.current;
    viewerActiveRef.current = false;

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
        if (disposed || lifecycleGenerationRef.current !== lifecycleGeneration) {
          viewer.dispose();
          return;
        }
        viewer.resize(width, height);
        viewerRef.current = viewer;
        viewerActiveRef.current = true;
        loadCurrent();
        if (debugRef.current) {
          const playback = debugRef.current;
          if (playback.name) viewer.playAnimation(animationNameForModel(playback.name, lastModelRef.current));
          viewer.setAnimationSpeed(playback.speed);
          if (playback.paused) viewer.pauseAnimation();
        } else if (interactive) {
          if (animations) viewer.playAnimation("float");
        } else if (animations) {
          // Show запускается после фактической загрузки скина, а не до неё.
          if (skinReadyRef.current) startHeroShowThenIdle();
        }
        if (visibleRef.current) startLoop();
        resetIdleTimer();
      })
      .catch(() => {
        if (!disposed && lifecycleGenerationRef.current === lifecycleGeneration) {
          setWebglFailed(true);
        }
      });

    return () => {
      disposed = true;
      viewerActiveRef.current = false;
      ++lifecycleGenerationRef.current;
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
        if (animationsRef.current && !debugRef.current && !interactive) startHeroShowThenIdle();
      } else {
        interruptHeroShow();
        stopHeroIdleLoop();
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
      if (animationsRef.current && !debugRef.current && !interactive) startHeroShowThenIdle();
    } else {
      canvas.style.display = "none";
      stopLoop();
      interruptHeroShow();
      heroShowGenerationRef.current += 1;
      if (heroShowTimerRef.current) {
        clearTimeout(heroShowTimerRef.current);
        heroShowTimerRef.current = null;
      }
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
    if (!viewer || debugRef.current) return;
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
        startHeroShowThenIdle();
      } else {
        stopHeroIdleLoop();
        viewer.stopAnimation();
        renderOnce();
      }
    }
  }, [animations, interactive]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !debugPlayback) return;
    if (debugPlayback.name) viewer.playAnimation(animationNameForModel(debugPlayback.name, lastModelRef.current));
    else viewer.stopAnimation();
    viewer.setAnimationSpeed(debugPlayback.speed);
    if (debugPlayback.paused) viewer.pauseAnimation();
    startLoop();
  }, [debugPlayback?.name, debugPlayback?.sequence]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !debugPlayback) return;
    viewer.setAnimationSpeed(debugPlayback.speed);
    if (debugPlayback.paused) viewer.pauseAnimation();
    else viewer.resumeAnimation();
    startLoop();
  }, [debugPlayback?.paused, debugPlayback?.speed]);

  /**
   * Hero idle-цикл: играет случайную анимацию из IDLE_ANIMATIONS, затем
   * раз в IDLE_CHECK_INTERVAL_MS (60 с) бросает кубик с шансом IDLE_SWITCH_CHANCE_PER_MIN
   * (по умолчанию 20 % в минуту ≈ в среднем раз в 5 минут). При «удаче» — переключает
   * на другую случайную анимацию и перезапускает таймер.
   * Таймер гасится при unmount / смене interactive / выключении анимаций.
   */
  function startHeroShowThenIdle() {
    if (!visibleRef.current || !focusedRef.current || document.hidden) return;
    if (heroShowPlayedRef.current) {
      startHeroIdleLoop();
      return;
    }
    const viewer = viewerRef.current;
    if (!viewer || !skinReadyRef.current) return;
    heroShowPlayedRef.current = true;
    heroShowActiveRef.current = true;
    stopHeroIdleLoop();
    if (!SHOW_ANIMATIONS.length) {
      startHeroIdleLoop();
      return;
    }
    const show = SHOW_ANIMATIONS[0];
    const generation = heroShowGenerationRef.current;
    viewer.playAnimation(animationNameForModel(show.name, lastModelRef.current));
    startLoop();
    if (heroShowTimerRef.current) clearTimeout(heroShowTimerRef.current);
    heroShowTimerRef.current = setTimeout(() => {
      heroShowTimerRef.current = null;
      if (generation === heroShowGenerationRef.current && viewerRef.current === viewer && visibleRef.current && focusedRef.current && !document.hidden && animationsRef.current && !debugRef.current && !interactive) {
        heroShowActiveRef.current = false;
        startHeroIdleLoop();
      }
    }, show.duration * 1000);
  }

  function startHeroIdleLoop() {
    stopHeroIdleLoop();
    const viewer = viewerRef.current;
    if (!viewer || !IDLE_ANIMATIONS.length) return;
    const pick = IDLE_ANIMATIONS[Math.floor(Math.random() * IDLE_ANIMATIONS.length)];
    viewer.playAnimation(animationNameForModel(pick.name, lastModelRef.current));
    heroIdleRef.current = pick.name;
    startLoop();
    scheduleHeroCheck();
  }

  function scheduleHeroCheck() {
    if (heroIdleTimerRef.current) clearTimeout(heroIdleTimerRef.current);
    const viewer = viewerRef.current;
    const lifecycleGeneration = lifecycleGenerationRef.current;
    if (!viewer || !viewerActiveRef.current) return;
    heroIdleTimerRef.current = setTimeout(() => {
      // Таймер принадлежит конкретному viewer/lifecycle. Не переносим его
      // на новый viewer после размонтирования или пересоздания WebGL.
      if (
        !isViewerActive(viewer, lifecycleGeneration) ||
        !animationsRef.current ||
        !visibleRef.current ||
        !focusedRef.current ||
        document.hidden ||
        debugRef.current ||
        interactive
      ) return;

      // Бросок кубика: IDLE_SWITCH_CHANCE_PER_MIN шанс за каждый интервал
      const shouldSwitch = Math.random() < IDLE_SWITCH_CHANCE_PER_MIN;
      if (shouldSwitch) {
        const current = heroIdleRef.current;
        const pool = IDLE_ANIMATIONS.filter((a) => a.name !== current);
        // При единственном idle «переключение» не должно перезапускать тот же клип.
        const pick = pool.length ? pool[Math.floor(Math.random() * pool.length)] : undefined;
        if (pick) {
          viewer.playAnimation(animationNameForModel(pick.name, lastModelRef.current));
          heroIdleRef.current = pick.name;
          startLoop();
        }
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
    if (heroShowTimerRef.current) {
      clearTimeout(heroShowTimerRef.current);
      heroShowTimerRef.current = null;
    }
    heroIdleRef.current = null;
  }

  function interruptHeroShow() {
    if (!heroShowActiveRef.current) return;
    heroShowActiveRef.current = false;
    heroShowPlayedRef.current = false;
    heroShowGenerationRef.current += 1;
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
