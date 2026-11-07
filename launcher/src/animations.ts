/** Исправленная анимация idle из Blockbench. Время ключей задано в секундах. */
import { BoneIndex, degToRad, quatFromEuler, quatMultiply, quatInvert, vec3, type Animation } from "@daidr/minecraft-skin-renderer";

type Point = readonly [time: number, x: number, y: number, z: number];
const duration = 2.2916666666666665;

type Vector = [number, number, number];
type Quaternion = ReturnType<typeof quatFromEuler>;
type Source = { boneIndex: BoneIndex; rotations: readonly Point[]; positions: readonly Point[] };

// Blockbench использует THREE.SplineCurve: равномерный Catmull–Rom с
// повторением крайних точек; время задаёт положение внутри текущего сегмента.
export function sampleCurve(points: readonly Point[], time: number): Vector {
  if (time <= points[0][0]) return [...points[0].slice(1)] as Vector;
  const last = points[points.length - 1];
  if (time >= last[0]) return [...last.slice(1)] as Vector;
  const i = points.findIndex((p, index) => index > 0 && p[0] >= time) - 1;
  const a = points[Math.max(0, i - 1)], b = points[i], c = points[i + 1], d = points[Math.min(points.length - 1, i + 2)];
  const t = (time - b[0]) / (c[0] - b[0]);
  return [1, 2, 3].map(k => 0.5 * (2*b[k] + (-a[k]+c[k])*t + (2*a[k]-5*b[k]+4*c[k]-d[k])*t*t + (-a[k]+3*b[k]-3*c[k]+d[k])*t*t*t)) as Vector;
}

const add = (a: Vector, b: Vector): Vector => [a[0]+b[0], a[1]+b[1], a[2]+b[2]];
const sub = (a: Vector, b: Vector): Vector => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
function rotate(q: Quaternion, v: Vector): Vector {
  const r = quatMultiply(quatMultiply(q, [v[0], v[1], v[2], 0]), quatInvert(q));
  return [r[0], r[1], r[2]];
}
function rotation(p: Vector): Quaternion {
  // Оси модели Blockbench отражены по X относительно модели renderer.
  return quatFromEuler(degToRad(p[0]), degToRad(-p[1]), degToRad(-p[2]));
}
// Blockbench и renderer используют противоположное направление глубины.
// X также отражён из-за зеркального базиса модели, поэтому конвертируем обе
// оси, перпендикулярные вертикали. Без инверсии Z шаг назад становился шагом
// вперёд, хотя углы и поза выглядели правильно.
const mirror = (p: Vector): Vector => [-p[0], p[1], -p[2]];
function tracks(boneIndex: BoneIndex, rotations: readonly Point[], positions: readonly Point[]): Source[] {
  return [{ boneIndex, rotations, positions }];
}

const source: Source[] = [
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
];

// Поворот каждой части в исходнике независим от Body: Waist неподвижен,
// а ноги находятся в корне. У renderer все части — дети Body.
const rest: Record<number, Vector> = {
  [BoneIndex.Body]: [0,24,0], [BoneIndex.Head]: [0,24,0],
  [BoneIndex.RightArm]: [-6,24,0], [BoneIndex.LeftArm]: [6,24,0],
  [BoneIndex.RightLeg]: [-2,12,0], [BoneIndex.LeftLeg]: [2,12,0],
};
const pivot: Record<number, Vector> = {
  [BoneIndex.Body]: [0,24,0], [BoneIndex.Head]: [0,24,0],
  [BoneIndex.RightArm]: [-5,22,0], [BoneIndex.LeftArm]: [5,22,0],
  [BoneIndex.RightLeg]: [-2.39975,0.05103,0.87075],
  [BoneIndex.LeftLeg]: [2.3094,0.00366,0],
};

function bake(slim: boolean): Animation["tracks"] {
  const modelRest: Record<number, Vector> = slim
    ? { ...rest, [BoneIndex.RightArm]: [-5.5,24,0], [BoneIndex.LeftArm]: [5.5,24,0] }
    : rest;
  const body = source.find(s => s.boneIndex === BoneIndex.Body)!;
  // Общая сетка включает все исходные ключи и конец клипа; renderer
  // между ними использует lerp/slerp, поэтому bake остаётся приближением.
  const times = new Set<number>([0, duration]);
  for (const s of source) for (const p of [...s.rotations, ...s.positions]) times.add(p[0]);
  for (let t = 1 / 120; t < duration; t += 1 / 120) times.add(t);
  const sorted = [...times].sort((a,b) => a-b);
  return source.map(s => ({ boneIndex: s.boneIndex, keyframes: sorted.map(time => {
    const bodyQ = rotation(sampleCurve(body.rotations, time));
    const bodyPosition = mirror(sampleCurve(body.positions, time));
    const q = rotation(sampleCurve(s.rotations, time));
    const position = mirror(sampleCurve(s.positions, time));
    const shift = sub(pivot[s.boneIndex], modelRest[s.boneIndex]);
    const worldPosition = add(add(modelRest[s.boneIndex], position), sub(shift, rotate(q, shift)));
    if (s.boneIndex === BoneIndex.Body) return { time: time / duration, rotation: q, position: vec3(...position) };
    const localPosition = sub(rotate(quatInvert(bodyQ), sub(sub(worldPosition, modelRest[BoneIndex.Body]), bodyPosition)), sub(modelRest[s.boneIndex], modelRest[BoneIndex.Body]));
    return { time: time / duration, rotation: quatMultiply(quatInvert(bodyQ), q), position: vec3(...localPosition) };
  }) }));
}

export const IDLE_ANIMATIONS: Animation[] = [{ name: "bb_idle", duration, loop: false, tracks: bake(false) }];
export const SLIM_IDLE_ANIMATIONS: Animation[] = [{ name: "bb_idle_slim", duration, loop: false, tracks: bake(true) }];

/** Отладочный UI и цикл используют общие имена, движок — варианты модели. */
export function animationNameForModel(name: string, model: "classic" | "slim"): string {
  if (model !== "slim") return name;
  const index = IDLE_ANIMATIONS.findIndex(animation => animation.name === name);
  return index < 0 ? name : SLIM_IDLE_ANIMATIONS[index].name;
}
