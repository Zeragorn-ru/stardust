/** Исправленная анимация idle из Blockbench. Время ключей задано в секундах. */
import { BoneIndex, degToRad, quatFromEuler, quatMultiply, quatInvert, vec3, type Animation } from "@daidr/minecraft-skin-renderer";

type Point = readonly [time: number, x: number, y: number, z: number];
const duration = 2.2916666666666665;

export type Vector = [number, number, number];
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
  // Raw keyframes Blockbench: ZYX; базис renderer повёрнут на 180° вокруг Y.
  // Bedrock-экспорт отдельно инвертирует X и Y и здесь не принимается.
  const [x, y, z] = [-p[0], p[1], -p[2]].map(v => degToRad(v) / 2);
  const sx = Math.sin(x), cx = Math.cos(x), sy = Math.sin(y), cy = Math.cos(y), sz = Math.sin(z), cz = Math.cos(z);
  return [sx*cy*cz - cx*sy*sz, cx*sy*cz + sx*cy*sz, cx*cy*sz - sx*sy*cz, cx*cy*cz + sx*sy*sz];
}
// Blockbench и renderer используют противоположное направление глубины.
// X также отражён из-за зеркального базиса модели, поэтому конвертируем обе
// оси, перпендикулярные вертикали. Без инверсии Z шаг назад становился шагом
// вперёд, хотя углы и поза выглядели правильно.
const mirror = (p: Vector): Vector => [-p[0], p[1], -p[2]];
function tracks(boneIndex: BoneIndex, rotations: readonly Point[], positions: readonly Point[]): Source[] {
  return [{ boneIndex, rotations, positions }];
}

const idleSource: Source[] = [
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

// Вход соответствует сериализованной анимации Blockbench; значения выражений
// Molang намеренно не вычисляются: поддерживаются только числовые компоненты.
type BBScalar = number | string;
type BBPoint = { x?: BBScalar | BBScalar[]; y?: BBScalar | BBScalar[]; z?: BBScalar | BBScalar[] } | BBScalar[];
type BBKey = { channel?: string; time?: BBScalar; data_points?: BBPoint[]; interpolation?: string; bezier_left_value?: BBPoint; bezier_right_value?: BBPoint; bezier_left_time?: BBScalar | BBScalar[]; bezier_right_time?: BBScalar | BBScalar[] };
type BBBone = { type?: string; name?: string; rotation_global?: boolean; keyframes?: BBKey[]; rotation?: Record<string, unknown>; position?: Record<string, unknown> };
export type BlockbenchAnimation = { name: string; length?: number | string; animation_length?: number | string; loop?: boolean | string; quaternion_interpolation?: boolean; animators?: Record<string, BBBone>; bones?: Record<string, BBBone> };
export type SourceLayout = { pivots: Record<string, Vector>; waistPivot: Vector; waistChildren: string[] };
export type BlockbenchInput = BlockbenchAnimation | { type: "animation"; content: BlockbenchAnimation };
type Key = { time: number; before: Vector; after: Vector; interpolation: string; bezierLeft?: Vector; bezierRight?: Vector; bezierLeftTime?: Vector; bezierRightTime?: Vector };
type Channel = Key[];
type Parsed = { rotations: Channel; positions: Channel; global: boolean };
const indices: Record<string, BoneIndex> = { head: BoneIndex.Head, body: BoneIndex.Body, rightarm: BoneIndex.RightArm, leftarm: BoneIndex.LeftArm, rightleg: BoneIndex.RightLeg, leftleg: BoneIndex.LeftLeg };
const number = (v: unknown): number => {
  if ((typeof v !== "number" && typeof v !== "string") || (typeof v === "string" && !v.trim())) throw new Error(`Некорректное числовое значение Blockbench: ${String(v)}`);
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Некорректное число или неподдерживаемое выражение Molang: ${String(v)}`);
  return n;
};
function vector(value: unknown): Vector {
  if (Array.isArray(value)) {
    if (value.length !== 3) throw new Error("Ожидалась точка Blockbench с тремя компонентами");
    return value.map(number) as Vector;
  }
  if (!value || typeof value !== "object") throw new Error("Ожидалась точка Blockbench с x/y/z");
  const p = value as BBPoint & Record<string, unknown>;
  return [number(p.x === undefined ? 0 : p.x), number(p.y === undefined ? 0 : p.y), number(p.z === undefined ? 0 : p.z)];
}
function scalar(value: BBScalar | BBScalar[] | undefined, index: number, fallback: number): number {
  if (value === undefined) return fallback;
  return number(Array.isArray(value) ? value[index] : value);
}
function channel(bone: BBBone, name: "rotation" | "position", duration: number): Channel {
  if (bone.rotation !== undefined || bone.position !== undefined) throw new Error("Формат каналов rotation/position не поддерживается; используйте keyframes");
  if (bone.keyframes !== undefined && !Array.isArray(bone.keyframes)) throw new Error("keyframes должен быть массивом");
  const keys: Key[] = [];
  for (const k of bone.keyframes ?? []) {
    if (!k || (k.channel !== "rotation" && k.channel !== "position")) throw new Error(`Неподдерживаемый канал Blockbench: ${k?.channel}`);
    if (k.channel !== name) continue;
    const interpolation = k.interpolation ?? "linear";
    if (!["linear", "catmullrom", "catmull_rom", "bezier"].includes(interpolation)) throw new Error(`Неподдерживаемая интерполяция: ${interpolation}`);
    if (!Array.isArray(k.data_points) || k.data_points.length !== 1) throw new Error("Поддерживается ровно один data_point на ключ; разрывы не поддерживаются");
    const time = number(k.time);
    if (time < 0 || time > duration) throw new Error(`Время ключа вне анимации: ${time}`);
    const point = vector(k.data_points[0]);
    const bezierLeft = k.bezier_left_value === undefined ? undefined : vector(k.bezier_left_value);
    const bezierRight = k.bezier_right_value === undefined ? undefined : vector(k.bezier_right_value);
    // Blockbench stores bezier_*_time as offsets from the key, often per axis.
    // Keep all three components in the source JSON, using the matching component
    // for each value axis while solving the cubic time curve.
    const bezierLeftTime = k.bezier_left_time === undefined ? undefined : [0, 1, 2].map(index => scalar(k.bezier_left_time, index, 0) + time) as Vector;
    const bezierRightTime = k.bezier_right_time === undefined ? undefined : [0, 1, 2].map(index => scalar(k.bezier_right_time, index, 0) + time) as Vector;
    keys.push({ time, before: point, after: point, interpolation, bezierLeft, bezierRight, bezierLeftTime, bezierRightTime });
  }
  keys.sort((a, b) => a.time - b.time);
  for (let i = 1; i < keys.length; i++) if (keys[i].time === keys[i-1].time) throw new Error(`Дубликат ключа ${name} на времени ${keys[i].time}`);
  return keys;
}
function sample(keys: Channel, time: number, loop: boolean): Vector {
  if (!keys.length) return [0, 0, 0];
  if (time < keys[0].time) return keys[0].before;
  let i = keys.findIndex(k => k.time > time);
  if (i < 0) return keys[keys.length - 1].after;
  const a = keys[i - 1], b = keys[i], t = (time - a.time) / (b.time - a.time);
  if (a.interpolation === "step") return a.after;
  if (a.interpolation === "bezier" || b.interpolation === "bezier") {
    const c1 = a.bezierRight ?? a.after;
    const c2 = b.bezierLeft ?? b.before;
    // Blockbench may store non-uniform control times per value axis. Solve
    // each cubic time curve first, then evaluate that axis's value curve.
    return [0, 1, 2].map(axis => {
      const time1 = a.bezierRightTime === undefined ? 1 / 3 : (a.bezierRightTime[axis] - a.time) / (b.time - a.time);
      const time2 = b.bezierLeftTime === undefined ? 2 / 3 : (b.bezierLeftTime[axis] - a.time) / (b.time - a.time);
      let u = t;
      for (let iteration = 0; iteration < 8; iteration++) {
        const one = 1 - u;
        const curveTime = 3 * one * one * u * time1 + 3 * one * u * u * time2 + u * u * u;
        const derivative = 3 * one * one * time1 + 6 * one * u * (time2 - time1) + 3 * u * u * (1 - time2);
        if (Math.abs(derivative) < 1e-8) break;
        u = Math.max(0, Math.min(1, u - (curveTime - t) / derivative));
      }
      const one = 1 - u;
      return one*one*one*a.after[axis] + 3*one*one*u*c1[axis] + 3*one*u*u*c2[axis] + u*u*u*b.before[axis];
    }) as Vector;
  }
  if (a.interpolation === "catmullrom" || a.interpolation === "catmull_rom" || b.interpolation === "catmullrom" || b.interpolation === "catmull_rom") {
    // Blockbench smooths a segment when either endpoint is catmullrom. Its
    // SplineCurve receives one duplicate endpoint at each open boundary;
    // looped channels instead use the opposite interior key as neighbour.
    const previous = loop && i === 1 ? keys[keys.length - 2] : keys[Math.max(0, i - 2)];
    const following = loop && i === keys.length - 1 ? keys[1] : keys[Math.min(keys.length - 1, i + 1)];
    const prev = previous?.after ?? a.after;
    const next = following?.before ?? b.before;
    return [0, 1, 2].map(k => 0.5 * (2*a.after[k] + (-prev[k]+b.before[k])*t + (2*prev[k]-5*a.after[k]+4*b.before[k]-next[k])*t*t + (-prev[k]+3*a.after[k]-3*b.before[k]+next[k])*t*t*t)) as Vector;
  }
  return a.after.map((v, k) => v + (b.before[k] - v) * t) as Vector;
}

/** Конвертация скелета Blockbench в локальные треки renderer. */
export function convertBlockbenchAnimation(input: BlockbenchInput, model: "classic" | "slim" = "classic", layout?: SourceLayout): Animation {
  if (!input || typeof input !== "object") throw new Error("Некорректный формат анимации");
  const animation = "type" in input ? (input.type === "animation" ? input.content : null) : input;
  if (!animation || typeof animation !== "object" || typeof animation.name !== "string" || !animation.name.trim()) throw new Error("Некорректный формат или имя анимации Blockbench");
  if (model !== "classic" && model !== "slim") throw new Error(`Неизвестная модель: ${model}`);
  if (![undefined, false, true, "once", "loop"].includes(animation.loop)) throw new Error(`Неподдерживаемый loop: ${animation.loop}`);
  if (animation.quaternion_interpolation === true) throw new Error("quaternion_interpolation=true не поддерживается");
  if (animation.animators !== undefined && animation.bones !== undefined) throw new Error("Нельзя одновременно задавать animators и bones");
  const collection = animation.animators ?? animation.bones;
  if (!collection || typeof collection !== "object" || Array.isArray(collection)) throw new Error("Ожидался объект animators или bones");
  const duration = number(animation.length ?? animation.animation_length ?? 0);
  // Bake создаёт 120 кадров в секунду для каждой кости. Ограничиваем размер,
  // чтобы повреждённый файл не заблокировал интерфейс и не исчерпал память.
  if (duration <= 0 || duration > 60) throw new Error("Длительность анимации должна быть от 0 до 60 секунд");
  const parsed = new Map<string, Parsed>();
  for (const [id, bone] of Object.entries(collection)) {
    if (!bone || typeof bone !== "object" || Array.isArray(bone)) throw new Error(`Некорректный аниматор: ${id}`);
    if (bone.type !== undefined && bone.type !== "bone") throw new Error(`Неподдерживаемый тип аниматора: ${bone.type}`);
    if (bone.rotation_global !== undefined && typeof bone.rotation_global !== "boolean") throw new Error(`Некорректный rotation_global: ${id}`);
    const rawName = bone.name ?? id;
    if (typeof rawName !== "string" || !rawName.trim()) throw new Error(`Некорректное имя кости: ${id}`);
    const name = rawName.replace(/[ _-]/g, "").toLowerCase();
    if (name !== "waist" && !Object.prototype.hasOwnProperty.call(indices, name)) throw new Error(`Неизвестная кость: ${name}`);
    if (parsed.has(name)) throw new Error(`Дубликат аниматора кости: ${name}`);
    parsed.set(name, { rotations: channel(bone, "rotation", duration), positions: channel(bone, "position", duration), global: bone.rotation_global === true });
  }
  const empty: Parsed = { rotations: [], positions: [], global: false };
  const waist = parsed.get("waist") ?? empty;
  // Для global-поворота дочернего pivot при вращении родителя нужна отдельная
  // реконструкция матрицы Blockbench; не выдаём приближение за верную позу.
  if (waist.rotations.length && [...parsed].some(([name, bone]) => name !== "waist" && bone.global)) {
    throw new Error("rotation_global с анимированным вращением waist не поддерживается");
  }
  const modelRest = model === "slim" ? { ...rest, [BoneIndex.RightArm]: [-5.5,24,0] as Vector, [BoneIndex.LeftArm]: [5.5,24,0] as Vector } : rest;
  const sourceLayout = layout ?? {
    pivots: Object.fromEntries(Object.entries(indices).map(([name, index]) => [name, pivot[index]])),
    waistPivot: rest[BoneIndex.Body], waistChildren: ["head", "body", "rightarm", "leftarm"],
  };
  if (!sourceLayout || !sourceLayout.pivots || !Array.isArray(sourceLayout.waistChildren)) throw new Error("Некорректный source layout");
  const validateVector = (v: Vector | undefined, label: string): Vector => {
    if (!Array.isArray(v) || v.length !== 3 || !v.every(n => typeof n === "number" && Number.isFinite(n))) throw new Error(`Некорректный pivot: ${label}`);
    return v;
  };
  validateVector(sourceLayout.waistPivot, "waist");
  for (const name of Object.keys(indices)) validateVector(sourceLayout.pivots[name], name);
  if (sourceLayout.waistChildren.some(name => !Object.prototype.hasOwnProperty.call(indices, name)) || new Set(sourceLayout.waistChildren).size !== sourceLayout.waistChildren.length) throw new Error("Некорректные дети waist в source layout");
  const times = new Set<number>([0, duration]);
  for (const bone of parsed.values()) for (const key of [...bone.rotations, ...bone.positions]) if (key.time >= 0 && key.time <= duration) times.add(key.time);
  for (let t = 1 / 120; t < duration; t += 1 / 120) times.add(t);
  const sorted = [...times].sort((a,b) => a-b);
  // Body нужен даже при анимации только другого сустава: он является корнем renderer.
  const names = Object.keys(indices);
  const tracks = names.map(name => ({ boneIndex: indices[name], keyframes: sorted.map(time => {
    const wq = rotation(sample(waist.rotations, time, animation.loop === true || animation.loop === "loop"));
    const wp = mirror(sample(waist.positions, time, animation.loop === true || animation.loop === "loop"));
    const world = (part: string) => {
      const index = indices[part], data = parsed.get(part) ?? empty;
      const localQ = rotation(sample(data.rotations, time, animation.loop === true || animation.loop === "loop"));
      const child = sourceLayout.waistChildren.includes(part);
      const q = child && !data.global ? quatMultiply(wq, localQ) : localQ;
      const position = mirror(sample(data.positions, time, animation.loop === true || animation.loop === "loop"));
      const shift = sub(sourceLayout.pivots[part], modelRest[index]);
      let pos = add(add(modelRest[index], position), sub(shift, rotate(localQ, shift)));
      if (child) pos = add(add(sourceLayout.waistPivot, wp), rotate(wq, sub(pos, sourceLayout.waistPivot)));
      return { q, pos };
    };
    const b = world("body"), current = world(name), index = indices[name];
    if (name === "body") return { time: time / duration, rotation: b.q, position: vec3(...sub(b.pos, modelRest[index])) };
    const local = sub(rotate(quatInvert(b.q), sub(current.pos, b.pos)), sub(modelRest[index], modelRest[BoneIndex.Body]));
    return { time: time / duration, rotation: quatMultiply(quatInvert(b.q), current.q), position: vec3(...local) };
  }) }));
  return { name: animation.name, duration, loop: animation.loop === true || animation.loop === "loop", tracks };
}

// Исходные ключи сохраняются в стандартной структуре Blockbench.
export const BB_IDLE: BlockbenchAnimation = {
  name: "bb_idle", length: duration, loop: false,
  animators: Object.fromEntries(idleSource.map(s => [BoneIndex[s.boneIndex], {
    name: BoneIndex[s.boneIndex], rotation_global: s.boneIndex === BoneIndex.RightArm,
    keyframes: ([...s.rotations.map(p => ({ p, channel: "rotation" })), ...s.positions.map(p => ({ p, channel: "position" }))]).map(({ p, channel }) => ({ channel, time: p[0], interpolation: "catmullrom", data_points: [{ x: p[1], y: p[2], z: p[3] }] }))
  }]))
};
/** Show-анимация из последнего пользовательского Blockbench JSON. */
const bezier = (x: number, y: number, z: number) => ({ x, y, z });
const showBezier = () => ({
  bezier_left_time: [-0.1, -0.1, -0.1], bezier_left_value: [0, 0, 0],
  bezier_right_time: [0.1, 0.1, 0.1], bezier_right_value: [0, 0, 0],
});
export const BB_SHOW: BlockbenchAnimation = {
  name: "show", length: 1, loop: "once",
  // Body и Waist намеренно отсутствуют: в исходном JSON у них нет ключей.
  animators: {
    Head: { name: "Head", keyframes: [
      { channel: "rotation", time: 0, interpolation: "linear", data_points: [bezier(-15, 0, 0)] },
      { channel: "rotation", time: 0.7916666666666666, interpolation: "linear", data_points: [bezier(-15, 0, 0)] },
      { channel: "rotation", time: 1, interpolation: "linear", data_points: [bezier(0, 0, 0)] },
      { channel: "position", time: 0, interpolation: "bezier", data_points: [bezier(0, 26, 0)], ...showBezier() },
      { channel: "position", time: 0.25, interpolation: "bezier", data_points: [bezier(0, 0, 0)], ...showBezier() },
    ] },
    RightArm: { name: "Right Arm", keyframes: [
      { channel: "position", time: 0, interpolation: "bezier", data_points: [bezier(47, 0, 0)], ...showBezier() },
      { channel: "position", time: 0.4583333333333333, interpolation: "bezier", data_points: [bezier(0, 0, 0)], ...showBezier() },
    ] },
    LeftArm: { name: "Left Arm", keyframes: [
      { channel: "position", time: 0, interpolation: "bezier", data_points: [bezier(-33, 0, 0)], ...showBezier() },
      { channel: "position", time: 0.3333333333333333, interpolation: "bezier", data_points: [bezier(0, 0, 0)], ...showBezier() },
    ] },
    RightLeg: { name: "Right Leg", keyframes: [
      { channel: "position", time: 0, interpolation: "bezier", data_points: [bezier(18, -30, 0)], ...showBezier() },
      { channel: "position", time: 0.625, interpolation: "bezier", data_points: [bezier(0, 0, 0)], ...showBezier() },
    ] },
    LeftLeg: { name: "Left Leg", keyframes: [
      { channel: "position", time: 0, interpolation: "bezier", data_points: [bezier(-28, -29, 0)], ...showBezier() },
      { channel: "position", time: 0.7083333333333334, interpolation: "bezier", data_points: [bezier(0, 0, 0)], ...showBezier() },
    ] },
  },
};

export const IDLE_ANIMATIONS: Animation[] = [convertBlockbenchAnimation(BB_IDLE)];
export const SLIM_IDLE_ANIMATIONS: Animation[] = [{ ...convertBlockbenchAnimation(BB_IDLE, "slim"), name: "bb_idle_slim" }];
export const SHOW_ANIMATIONS: Animation[] = [convertBlockbenchAnimation(BB_SHOW)];
export const SLIM_SHOW_ANIMATIONS: Animation[] = [{ ...convertBlockbenchAnimation(BB_SHOW, "slim"), name: "show_slim" }];

/** Отладочный UI и цикл используют общие имена, движок — варианты модели. */
export function animationNameForModel(name: string, model: "classic" | "slim"): string {
  if (model !== "slim") return name;
  const idleIndex = IDLE_ANIMATIONS.findIndex(animation => animation.name === name);
  if (idleIndex >= 0) return SLIM_IDLE_ANIMATIONS[idleIndex].name;
  const showIndex = SHOW_ANIMATIONS.findIndex(animation => animation.name === name);
  return showIndex >= 0 ? SLIM_SHOW_ANIMATIONS[showIndex].name : name;
}
