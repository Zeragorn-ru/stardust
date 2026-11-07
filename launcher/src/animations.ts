/**
 * Idle-анимации для 3D-модели скина на главном экране.
 *
 * SkinViewer3D регистрирует каждую из них через registerAnimation и раз в
 * IDLE_SWITCH_INTERVAL_MS случайно включает одну (см. SkinViewer3D.tsx).
 *
 * Формат — нативный `Animation` из @daidr/minecraft-skin-renderer:
 *   name:      уникальное имя (по нему playAnimation запускает клип)
 *   duration:  секунд на цикл
 *   loop:      зациклить ли
 *   tracks[]:  кость (BoneIndex) + keyframes
 *     time:    0..1 (доля длительности, НЕ секунды)
 *     rotation:Quat — через quatFromEuler(radX, radY, radZ); градусы через degToRad
 *     position:Vec3 — через vec3(x, y, z); смещение в блоках модели
 *     easing:  функция плавности (см. импорты ниже)
 *
 * BoneIndex: Head, Body, LeftArm, RightArm, LeftLeg, RightLeg
 * Easing: linear, easeInSine/easeOutSine/easeInOutSine,
 *         easeInCubic/easeOutCubic/easeInOutCubic,
 *         easeInQuad/easeOutQuad/easeInOutQuad, bounce, elastic, halfSine, sineWave
 *
 * ── Как добавить свою анимацию из Blockbench ──
 * 1. Blockbench → вкладка Animate → New Animation, расставь keyframes по костям.
 * 2. File → Export → Export Animation (Model Format / JSON).
 * 3. В JSON: animation_length → duration (сек); bones.<кость>.rotation → keyframes.
 *    Blockbench хранит rotation в градусах → оберни в degToRad(...).
 *    Ключ "0.0", "2.0" — это время в секундах; раздели на duration → time 0..1.
 * 4. Добавь объект в массив IDLE_ANIMATIONS ниже — SkinViewer3D подхватит сам.
 *
 * Пример: Blockbench { "head": { "rotation": { "0": [0,0,0], "1": [15,0,0], "2": [0,0,0] } } }
 * при animation_length: 2 →
 *   { boneIndex: BoneIndex.Head, keyframes: [
 *       { time: 0,   rotation: quatFromEuler(0, 0, 0) },
 *       { time: 0.5, rotation: quatFromEuler(degToRad(15), 0, 0), easing: easeInOutSine },
 *       { time: 1,   rotation: quatFromEuler(0, 0, 0), easing: easeInOutSine } ] }
 */

import {
  BoneIndex,
  quatFromEuler,
  vec3,
  degToRad,
  easeInOutSine,
  easeOutSine,
  easeInSine,
  bounce,
  type Animation,
} from "@daidr/minecraft-skin-renderer";

export const IDLE_ANIMATIONS: Animation[] = [
  // 1. Покачивание рук — базовый idle, лёгкий размах предплечий.
  {
    name: "idle_hands_sway",
    duration: 3,
    loop: true,
    tracks: [
      {
        boneIndex: BoneIndex.RightArm,
        keyframes: [
          { time: 0, rotation: quatFromEuler(degToRad(0), 0, degToRad(-5)) },
          { time: 0.5, rotation: quatFromEuler(degToRad(0), 0, degToRad(0)), easing: easeInOutSine },
          { time: 1, rotation: quatFromEuler(degToRad(0), 0, degToRad(-5)), easing: easeInOutSine },
        ],
      },
      {
        boneIndex: BoneIndex.LeftArm,
        keyframes: [
          { time: 0, rotation: quatFromEuler(degToRad(0), 0, degToRad(5)) },
          { time: 0.5, rotation: quatFromEuler(degToRad(0), 0, degToRad(0)), easing: easeInOutSine },
          { time: 1, rotation: quatFromEuler(degToRad(0), 0, degToRad(5)), easing: easeInOutSine },
        ],
      },
    ],
  },

  // 2. Кивок головой — двойной кивок с затуханием.
  {
    name: "idle_head_nod",
    duration: 4,
    loop: true,
    tracks: [
      {
        boneIndex: BoneIndex.Head,
        keyframes: [
          { time: 0, rotation: quatFromEuler(0, 0, 0) },
          { time: 0.15, rotation: quatFromEuler(degToRad(-12), 0, 0), easing: easeInSine },
          { time: 0.35, rotation: quatFromEuler(0, 0, 0), easing: easeOutSine },
          { time: 0.5, rotation: quatFromEuler(degToRad(-6), 0, 0), easing: easeInSine },
          { time: 0.7, rotation: quatFromEuler(0, 0, 0), easing: easeOutSine },
          { time: 1, rotation: quatFromEuler(0, 0, 0) },
        ],
      },
    ],
  },

  // 3. Перекат корпуса — лёгкое покачивание из стороны в сторону (torso + head).
  {
    name: "idle_body_lean",
    duration: 5,
    loop: true,
    tracks: [
      {
        boneIndex: BoneIndex.Body,
        keyframes: [
          { time: 0, rotation: quatFromEuler(0, 0, degToRad(0)) },
          { time: 0.5, rotation: quatFromEuler(0, 0, degToRad(4)), easing: easeInOutSine },
          { time: 1, rotation: quatFromEuler(0, 0, degToRad(0)), easing: easeInOutSine },
        ],
      },
      {
        boneIndex: BoneIndex.Head,
        keyframes: [
          { time: 0, rotation: quatFromEuler(0, 0, degToRad(0)) },
          { time: 0.5, rotation: quatFromEuler(0, 0, degToRad(-4)), easing: easeInOutSine },
          { time: 1, rotation: quatFromEuler(0, 0, degToRad(0)), easing: easeInOutSine },
        ],
      },
    ],
  },

  // 4. Микро-подпрыгивание — корпус слегка проседает и отскакивает.
  {
    name: "idle_bounce",
    duration: 2.5,
    loop: true,
    tracks: [
      {
        boneIndex: BoneIndex.Body,
        keyframes: [
          { time: 0, position: vec3(0, 0, 0) },
          { time: 0.3, position: vec3(0, -0.12, 0), easing: easeInSine },
          { time: 0.6, position: vec3(0, 0, 0), easing: bounce },
          { time: 1, position: vec3(0, 0, 0) },
        ],
      },
    ],
  },

  // 5. Махание рукой — правая рука поднимается и машет.
  {
    name: "idle_wave",
    duration: 3.5,
    loop: true,
    tracks: [
      {
        boneIndex: BoneIndex.RightArm,
        keyframes: [
          { time: 0, rotation: quatFromEuler(degToRad(0), 0, degToRad(-5)) },
          { time: 0.2, rotation: quatFromEuler(degToRad(-140), 0, degToRad(-5)), easing: easeOutSine },
          { time: 0.35, rotation: quatFromEuler(degToRad(-140), 0, degToRad(15)), easing: easeInOutSine },
          { time: 0.5, rotation: quatFromEuler(degToRad(-140), 0, degToRad(-15)), easing: easeInOutSine },
          { time: 0.65, rotation: quatFromEuler(degToRad(-140), 0, degToRad(15)), easing: easeInOutSine },
          { time: 0.8, rotation: quatFromEuler(degToRad(-140), 0, degToRad(-15)), easing: easeInOutSine },
          { time: 1, rotation: quatFromEuler(degToRad(0), 0, degToRad(-5)), easing: easeInSine },
        ],
      },
    ],
  },

  // 6. Осмотр по сторонам — голова медленно крутится влево-вправо.
  {
    name: "idle_look_around",
    duration: 6,
    loop: true,
    tracks: [
      {
        boneIndex: BoneIndex.Head,
        keyframes: [
          { time: 0, rotation: quatFromEuler(0, degToRad(0), 0) },
          { time: 0.25, rotation: quatFromEuler(0, degToRad(25), 0), easing: easeInOutSine },
          { time: 0.5, rotation: quatFromEuler(0, degToRad(0), 0), easing: easeInOutSine },
          { time: 0.75, rotation: quatFromEuler(0, degToRad(-25), 0), easing: easeInOutSine },
          { time: 1, rotation: quatFromEuler(0, degToRad(0), 0), easing: easeInOutSine },
        ],
      },
    ],
  },

  // 7. Пользовательская idle-анимация из Blockbench (длина 2.5 с, один цикл).
  {
    name: "bb_idle",
    duration: 2.5,
    loop: true,
    tracks: [
      {
        boneIndex: BoneIndex.Head,
        keyframes: [
          { time: 0, rotation: quatFromEuler(0, 0, 0) },
          { time: 0.2, rotation: quatFromEuler(degToRad(0), degToRad(-68), degToRad(0)), easing: easeInOutSine },
          { time: 0.333332, rotation: quatFromEuler(degToRad(0), degToRad(-47), degToRad(0)), easing: easeInOutSine },
          { time: 0.633332, rotation: quatFromEuler(degToRad(0), degToRad(-47), degToRad(0)), easing: easeInOutSine },
          { time: 0.9, rotation: quatFromEuler(0, 0, 0), easing: easeInOutSine },
        ],
      },
      {
        boneIndex: BoneIndex.Body,
        keyframes: [
          { time: 0, rotation: quatFromEuler(0, 0, 0) },
          { time: 0.2, rotation: quatFromEuler(degToRad(-3.0542), degToRad(-20.3258), degToRad(0.1672)), easing: easeInOutSine },
          { time: 0.333332, rotation: quatFromEuler(degToRad(-1.3094), degToRad(-27.5464), degToRad(0.229)), easing: easeInOutSine },
          { time: 0.633332, rotation: quatFromEuler(degToRad(-1.3094), degToRad(-27.5464), degToRad(0.229)), easing: easeInOutSine },
          { time: 0.733332, rotation: quatFromEuler(degToRad(-3.0542), degToRad(-20.3258), degToRad(0.1672)), easing: easeInOutSine },
          { time: 0.9, rotation: quatFromEuler(0, 0, 0), easing: easeInOutSine },
        ],
      },
      {
        boneIndex: BoneIndex.RightArm,
        keyframes: [
          { time: 0, rotation: quatFromEuler(degToRad(0), degToRad(0), degToRad(2.5)) },
          { time: 0.2, rotation: quatFromEuler(degToRad(-1.0863), degToRad(-22.9965), degToRad(2.9245)), easing: easeInOutSine },
          { time: 0.333332, rotation: quatFromEuler(degToRad(0.0001), degToRad(-23), degToRad(2)), easing: easeInOutSine },
          { time: 0.633332, rotation: quatFromEuler(degToRad(0.0001), degToRad(-23), degToRad(2)), easing: easeInOutSine },
          { time: 0.733332, rotation: quatFromEuler(degToRad(-7.5978), degToRad(-22.819), degToRad(2.9614)), easing: easeInOutSine },
          { time: 0.9, rotation: quatFromEuler(degToRad(0), degToRad(0), degToRad(2.5)), easing: easeInOutSine },
        ],
      },
      {
        boneIndex: BoneIndex.LeftArm,
        keyframes: [
          { time: 0, rotation: quatFromEuler(degToRad(0), degToRad(0), degToRad(-2.5)) },
          { time: 0.2, rotation: quatFromEuler(degToRad(-4.1275), degToRad(-24.6523), degToRad(-3.5114)), easing: easeInOutSine },
          { time: 0.333332, rotation: quatFromEuler(degToRad(-0.0865), degToRad(-24.6548), degToRad(-2.4111)), easing: easeInOutSine },
          { time: 0.633332, rotation: quatFromEuler(degToRad(-0.0865), degToRad(-24.6548), degToRad(-2.4111)), easing: easeInOutSine },
          { time: 0.733332, rotation: quatFromEuler(degToRad(1.8725), degToRad(-24.6523), degToRad(-3.5114)), easing: easeInOutSine },
          { time: 0.9, rotation: quatFromEuler(degToRad(0), degToRad(0), degToRad(-2.5)), easing: easeInOutSine },
        ],
      },
      {
        boneIndex: BoneIndex.RightLeg,
        keyframes: [
          { time: 0, rotation: quatFromEuler(0, 0, 0) },
          { time: 0.1, rotation: quatFromEuler(degToRad(-3.5), degToRad(-11), degToRad(0)), easing: easeInOutSine },
          { time: 0.2, rotation: quatFromEuler(degToRad(-4.9019), degToRad(-21.5223), degToRad(6.387)), easing: easeInOutSine },
          { time: 0.333332, rotation: quatFromEuler(degToRad(0.1916), degToRad(-21.9883), degToRad(3.1566)), easing: easeInOutSine },
          { time: 0.633332, rotation: quatFromEuler(degToRad(0.1916), degToRad(-21.9883), degToRad(3.1566)), easing: easeInOutSine },
          { time: 0.733332, rotation: quatFromEuler(degToRad(-4.9019), degToRad(-21.5223), degToRad(6.387)), easing: easeInOutSine },
          { time: 0.816668, rotation: quatFromEuler(degToRad(-3.5), degToRad(-11), degToRad(0)), easing: easeInOutSine },
          { time: 0.9, rotation: quatFromEuler(0, 0, 0), easing: easeInOutSine },
        ],
      },
      {
        boneIndex: BoneIndex.LeftLeg,
        keyframes: [
          { time: 0, rotation: quatFromEuler(degToRad(0), degToRad(0), degToRad(-2)) },
          { time: 0.2, rotation: quatFromEuler(degToRad(2.4748), degToRad(-17.8643), degToRad(-5.0215)), easing: easeInOutSine },
          { time: 0.333332, rotation: quatFromEuler(degToRad(5.9289), degToRad(-23.5772), degToRad(-8.6811)), easing: easeInOutSine },
          { time: 0.633332, rotation: quatFromEuler(degToRad(5.9289), degToRad(-23.5772), degToRad(-8.6811)), easing: easeInOutSine },
          { time: 0.733332, rotation: quatFromEuler(degToRad(2.4748), degToRad(-17.8643), degToRad(-5.0215)), easing: easeInOutSine },
          { time: 0.9, rotation: quatFromEuler(degToRad(0), degToRad(0), degToRad(-2)), easing: easeInOutSine },
        ],
      },
    ],
  },
];
