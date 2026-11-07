/** Исправленная анимация idle из Blockbench. Время ключей задано в секундах. */
import { BoneIndex, degToRad, quatFromEuler, vec3, type Animation } from "@daidr/minecraft-skin-renderer";

type Point = readonly [time: number, x: number, y: number, z: number];
const duration = 2.2916666666666665;

// Рендерер интерполирует соседние ключи линейно (вращения — через slerp).
// Выборка Catmull–Rom сохраняет форму кривой Blockbench ближе, чем easing.
function sample(points: readonly Point[], rotation: boolean) {
  const frames: Array<{ time: number; rotation?: ReturnType<typeof quatFromEuler>; position?: ReturnType<typeof vec3> }> = [];
  const add = (time: number, values: number[]) => {
    frames.push(rotation
      ? { time: time / duration, rotation: quatFromEuler(degToRad(values[0]), degToRad(values[1]), degToRad(values[2])) }
      : { time: time / duration, position: vec3(values[0], values[1], values[2]) });
  };
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[Math.max(0, i - 1)];
    const b = points[i];
    const c = points[i + 1];
    const d = points[Math.min(points.length - 1, i + 2)];
    for (let j = 0; j < 8; j++) {
      const t = j / 8;
      const values = [1, 2, 3].map(k => 0.5 * (2 * b[k] + (-a[k] + c[k]) * t + (2 * a[k] - 5 * b[k] + 4 * c[k] - d[k]) * t * t + (-a[k] + 3 * b[k] - 3 * c[k] + d[k]) * t * t * t));
      add(b[0] + (c[0] - b[0]) * t, values);
    }
  }
  const last = points[points.length - 1];
  add(last[0], [last[1], last[2], last[3]]);
  return frames;
}

function tracks(boneIndex: BoneIndex, rotations: readonly Point[], positions: readonly Point[]) {
  return [
    { boneIndex, keyframes: sample(rotations, true) },
    { boneIndex, keyframes: sample(positions, false) },
  ];
}

export const IDLE_ANIMATIONS: Animation[] = [{
  name: "bb_idle",
  duration,
  loop: false,
  tracks: [
    ...tracks(BoneIndex.Head,
      [[0,0,0,0],[0.5,0,-68,0],[1.5833333333333333,0,-47,0],[2.25,0,0,0]],
      [[0,0,0,0],[0.5,0.4,0.2,0.4],[0.8333333333333334,0.6,0.2,1.6],[1.5833333333333333,0.6,0.2,1.6],[2.25,0,0,0]]),
    ...tracks(BoneIndex.Body,
      [[0,0,0,0],[0.5,-3.0542,-20.3258,0.1672],[0.8333333333333334,-1.3094,-27.5464,0.229],[1.5833333333333333,-1.3094,-27.5464,0.229],[1.8333333333333333,-3.0542,-20.3258,0.1672],[2.25,0,0,0]],
      [[0,0,0,0],[0.5,0.39,0,0.5],[0.8333333333333334,0.5,0,1.9],[1.5833333333333333,0.5,0,1.9],[1.8333333333333333,0.39,0,0.5],[2.25,0,0,0]]),
    ...tracks(BoneIndex.RightArm,
      [[0,0,0,2.5],[0.5,-1.0863,-22.9965,2.9245],[0.8333333333333334,0.0001,-23,2],[1.5833333333333333,0.0001,-23,2],[1.8333333333333333,-7.5978,-22.819,2.9614],[2.25,0,0,2.5]],
      [[0,0,0,0],[0.5,0,0,2.6],[0.8333333333333334,0.1,0,4.3],[1.5833333333333333,0.1,0,4.3],[1.8333333333333333,0,0,2.6],[2.25,0,0,0]]),
    ...tracks(BoneIndex.LeftArm,
      [[0,0,0,-2.5],[0.5,-4.1275,-24.6523,-3.5114],[0.8333333333333334,-0.0865,-24.6548,-2.4111],[1.5833333333333333,-0.0865,-24.6548,-2.4111],[1.8333333333333333,1.8725,-24.6523,-3.5114],[2.25,0,0,-2.5]],
      [[0,0,0,0],[0.5,0.6,0,-1],[0.8333333333333334,1.2,0,-0.3],[1.5833333333333333,1.2,0,-0.3],[1.8333333333333333,0.6,0,-1],[2.25,0,0,0]]),
    ...tracks(BoneIndex.RightLeg,
      [[0,0,0,0],[0.25,-3.5,-11,0],[0.5,-4.9019,-21.5223,6.387],[0.8333333333333334,0.1916,-21.9883,3.1566],[1.5833333333333333,0.1916,-21.9883,3.1566],[1.8333333333333333,-4.9019,-21.5223,6.387],[2.0416666666666665,-3.5,-11,0],[2.25,0,0,0]],
      [[0,0,0,0],[0.25,0.1,0.8,1],[0.5,1.11,0.16,2.45],[0.8333333333333334,1.11,0.16,2.45],[1.5833333333333333,1.11,0.16,2.45],[1.8333333333333333,1.11,0.16,2.45],[2.0416666666666665,0.1,0.8,1],[2.25,0,0,0]]),
    ...tracks(BoneIndex.LeftLeg,
      [[0,0,0,-2],[0.5,2.4748,-17.8643,-5.0215],[0.8333333333333334,5.9289,-23.5772,-8.6811],[1.5833333333333333,5.9289,-23.5772,-8.6811],[1.8333333333333333,2.4748,-17.8643,-5.0215],[2.25,0,0,-2]],
      [[0,0,0,0],[2.25,0,0,0]]),
  ],
}];
