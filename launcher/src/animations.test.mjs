import test from 'node:test';
import assert from 'node:assert/strict';
import { BoneIndex, quatFromEuler, quatMultiply, quatInvert, degToRad } from '@daidr/minecraft-skin-renderer';
import { IDLE_ANIMATIONS, SLIM_IDLE_ANIMATIONS, SHOW_ANIMATIONS, SLIM_SHOW_ANIMATIONS, animationNameForModel, sampleCurve, convertBlockbenchAnimation, BB_IDLE, BB_SHOW } from './animations.ts';

const near = (a, b, eps = 1e-7) => assert.ok(Math.abs(a-b) < eps, `${a} != ${b}`);
const vectorNear = (a, b) => { assert.equal(a.length, b.length); a.forEach((v, i) => near(v, b[i])); };
const rotate = (q, v) => quatMultiply(quatMultiply(q, [...v, 0]), quatInvert(q)).slice(0, 3);
const sum = (a, b) => a.map((v, i) => v + b[i]);
const delta = (a, b) => a.map((v, i) => v - b[i]);
const q = (x,y,z) => quatMultiply(quatMultiply(quatFromEuler(0,0,degToRad(-z)), quatFromEuler(0,degToRad(y),0)), quatFromEuler(degToRad(-x),0,0));
// THREE Matrix4.makeRotationFromEuler ZYX, строками, независимо от quaternion.
const matrixZYX = (x,y,z) => {
  x = degToRad(-x); y = degToRad(y); z = degToRad(-z);
  const a=Math.cos(x), b=Math.sin(x), c=Math.cos(y), d=Math.sin(y), e=Math.cos(z), f=Math.sin(z);
  return [[c*e,b*d*e-a*f,a*d*e+b*f],[c*f,b*d*f+a*e,a*d*f-b*e],[-d,b*c,a*c]];
};
const matrixRotate = (m,v) => m.map(row => row.reduce((s,n,i) => s+n*v[i],0));
const clip = IDLE_ANIMATIONS[0];
function frame(bone, seconds, animation = clip) {
  const frames = animation.tracks.find(t => t.boneIndex === bone).keyframes;
  return frames.find(f => Math.abs(f.time * animation.duration - seconds) < 1e-10);
}

test('raw ZYX rotations match independent THREE matrices for mixed and signed axial angles', () => {
  for (const angles of [[30,45,60],[-37,21,113], [90,0,0],[-90,0,0],[0,90,0],[0,-90,0],[0,0,90],[0,0,-90]]) {
    const [x,y,z] = angles;
    const animation = convertBlockbenchAnimation({name:'rotation', length:1, animators:{body:{name:'Body', keyframes:[{channel:'rotation', time:0, data_points:[{x,y,z}]}]}}});
    const actual = frame(BoneIndex.Body, 0, animation).rotation;
    for (const basis of [[1,0,0],[0,1,0],[0,0,1]]) vectorNear(rotate(actual,basis), matrixRotate(matrixZYX(x,y,z),basis));
  }
});

test('global child rotation with animated waist is explicitly rejected', () => {
  const keyframes = [{channel:'rotation',time:0,data_points:[{x:30,y:20,z:10}]}];
  assert.throws(() => convertBlockbenchAnimation({name:'global',length:1,animators:{waist:{name:'Waist',keyframes},arm:{name:'RightArm',rotation_global:true,keyframes}}}), /rotation_global.*waist/);
});

test('Catmull–Rom follows Blockbench SplineCurve endpoints and unequal timing', () => {
  const points = [[0,0,0,0],[1,2,0,0],[3,0,0,0]];
  near(sampleCurve(points, 0.5)[0], 1.125);
  near(sampleCurve(points, 2)[0], 1.125);
  near(sampleCurve(points, 1)[0], 2);
  near(sampleCurve(points, 4)[0], 0);
});

test('Blockbench smooths a segment when either endpoint is catmullrom', () => {
  const input = { name: 'mixed', length: 3, animators: { Head: { keyframes: [
    { channel: 'position', time: 0, interpolation: 'linear', data_points: [{x: 0}] },
    { channel: 'position', time: 1, interpolation: 'catmullrom', data_points: [{x: 10}] },
    { channel: 'position', time: 2, interpolation: 'linear', data_points: [{x: 0}] },
    { channel: 'position', time: 3, interpolation: 'linear', data_points: [{x: 20}] },
  ] } } };
  const animation = convertBlockbenchAnimation(input);
  const f = frame(BoneIndex.Head, 0.5, animation);
  near(f.position[0], -5.625);
});

test('quaternion interpolation is rejected explicitly', () => {
  assert.throws(() => convertBlockbenchAnimation({ name: 'quat', length: 1, quaternion_interpolation: true, animators: {} }), /quaternion_interpolation/);
});

test('show keeps the exact source keys, absent Body/Waist, and model variants', () => {
  assert.equal(BB_SHOW.length, 1);
  assert.equal(BB_SHOW.animators.Body, undefined);
  assert.equal(BB_SHOW.animators.Waist, undefined);
  const expected = {
    Head: { rotation: [[0, -15], [0.7916666666666666, -15], [1, 0]] },
    'Right Arm': { position: [[0, 47], [0.4583333333333333, 0]] },
    'Left Arm': { position: [[0, -33], [0.3333333333333333, 0]] },
    'Right Leg': { position: [[0, 18, -30, 0], [0.625, 0, 0, 0]] },
    'Left Leg': { position: [[0, -28, -29, 0], [0.7083333333333334, 0, 0, 0]] },
  };
  for (const [name, channels] of Object.entries(expected)) {
    const bone = Object.values(BB_SHOW.animators).find(candidate => candidate.name === name);
    assert.ok(bone, name);
    for (const [channel, keys] of Object.entries(channels)) {
      const actual = bone.keyframes.filter(key => key.channel === channel);
      assert.deepEqual(actual.map(key => [key.time, ...Object.values(key.data_points[0]).slice(0, channel === 'rotation' ? 1 : (name.includes('Leg') ? 3 : 1))]), keys);
      assert.ok(actual.every(key => key.interpolation === 'linear' || key.interpolation === 'bezier'));
    }
  }
  assert.equal(SHOW_ANIMATIONS[0].duration, 1);
  assert.equal(SLIM_SHOW_ANIMATIONS[0].name, 'show_slim');
  assert.equal(animationNameForModel('show', 'slim'), 'show_slim');
});

test('bezier uses control values and non-uniform control times per axis', () => {
  const animation = convertBlockbenchAnimation({ name: 'bezier', length: 1, animators: { Head: { keyframes: [
    { channel: 'position', time: 0, interpolation: 'bezier', data_points: [{ x: 0, y: 0, z: 0 }], bezier_right_value: [10, 0, 0], bezier_right_time: [0.1, 0.25, 0.1] },
    { channel: 'position', time: 1, interpolation: 'linear', data_points: [{ x: 20, y: 20, z: 20 }], bezier_left_value: [10, 20, 10], bezier_left_time: [0.9, 0.75, 0.9] },
  ] } } });
  const f = frame(BoneIndex.Head, 0.5, animation);
  assert.ok(f.position.every(value => Number.isFinite(value)));
  assert.notDeepEqual(f.position, [10, 10, 10]);
  assert.ok(f.position.some(value => value !== 0));
});

test('BB_IDLE preserves the source key layout and global flags', () => {
  assert.equal(Object.keys(BB_IDLE.animators).length, 6);
  for (const [name, bone] of Object.entries(BB_IDLE.animators)) {
    assert.equal(bone.rotation_global, name === 'RightArm');
    assert.ok(bone.keyframes?.length);
    assert.ok(bone.keyframes.every(k => k.data_points?.length === 1));
  }
  assert.equal(BB_IDLE.animators.Waist, undefined);
});

test('baked tracks are complete, ordered and cover the once clip', () => {
  assert.equal(clip.loop, false);
  assert.equal(clip.duration, 2.2916666666666665);
  assert.equal(clip.tracks.length, 6);
  for (const animation of [clip, SLIM_IDLE_ANIMATIONS[0]]) for (const track of animation.tracks) {
    near(track.keyframes[0].time, 0);
    near(track.keyframes.at(-1).time, 1);
    for (let i=1; i<track.keyframes.length; i++) assert.ok(track.keyframes[i].time > track.keyframes[i-1].time);
    for (const f of track.keyframes) {
      assert.equal(f.position.length, 3);
      assert.equal(f.rotation.length, 4);
      assert.ok([...f.position, ...f.rotation].every(Number.isFinite));
      near(Math.hypot(...f.rotation), 1);
    }
  }
});

test('body parent is cancelled for head, global right arm and root leg', () => {
  const body = frame(BoneIndex.Body, 0.5);
  vectorNear(body.rotation, q(-3.0542,-20.3258,0.1672));
  const cases = [
    [BoneIndex.Head, q(0,-68,0), [0,24,0], [-0.4,0.2,-0.4]],
    [BoneIndex.RightArm, q(-1.0863,-22.9965,2.9245), [-6,24,0], [0,0,-2.6]],
    [BoneIndex.RightLeg, q(-4.9019,-21.5223,6.387), [-2,12,0], [-1.11,0.16,-2.45]],
  ];
  const pivots = { [BoneIndex.Head]: [0,24,0], [BoneIndex.RightArm]: [-5,22,0], [BoneIndex.RightLeg]: [-2.39975,0.05103,0.87075] };
  for (const [bone, worldQ, rest, position] of cases) {
    const f = frame(bone, 0.5);
    vectorNear(quatMultiply(body.rotation, f.rotation), worldQ);
    const offset = delta(rest, [0,24,0]);
    const actual = sum(sum([0,24,0], body.position), rotate(body.rotation, sum(offset, f.position)));
    const shift = delta(pivots[bone], rest);
    const expected = sum(sum(rest, position), delta(shift, rotate(worldQ, shift)));
    vectorNear(actual, expected);
  }
});

test('classic and slim arms match independent Euler-matrix world positions', () => {
  const cases = [[clip, 6], [SLIM_IDLE_ANIMATIONS[0], 5.5]];
  for (const [animation, width] of cases) {
    const body = frame(BoneIndex.Body, 0.5, animation);
    for (const [i, bone] of [BoneIndex.RightArm, BoneIndex.LeftArm].entries()) {
      const arm = frame(bone, 0.5, animation);
      const rest = [i === 0 ? -width : width, 0, 0];
      const world = sum(sum([0,24,0], body.position), rotate(body.rotation, sum(rest, arm.position)));
      const base = [i === 0 ? -width : width,24,0];
      const pivot = [i === 0 ? -5 : 5,22,0];
      const shift = delta(pivot, base);
      const source = BB_IDLE.animators[i === 0 ? 'RightArm' : 'LeftArm'];
      const rot = source.keyframes.find(k => k.channel === 'rotation' && k.time === 0.5).data_points[0];
      const pos = source.keyframes.find(k => k.channel === 'position' && k.time === 0.5).data_points[0];
      vectorNear(world, sum(sum(base, [-pos.x,pos.y,-pos.z]), delta(shift, matrixRotate(matrixZYX(rot.x,rot.y,rot.z), shift))));
    }
  }
});

test('model selection maps only registered idle names', () => {
  assert.equal(animationNameForModel('bb_idle', 'classic'), 'bb_idle');
  assert.equal(animationNameForModel('bb_idle', 'slim'), 'bb_idle_slim');
  assert.equal(animationNameForModel('float', 'slim'), 'float');
});

test('last keyed pose is held to clip end', () => {
  for (const track of clip.tracks) {
    const keyed = frame(track.boneIndex, 2.25);
    const end = track.keyframes.at(-1);
    vectorNear(keyed.rotation, end.rotation);
    vectorNear(keyed.position, end.position);
  }
});


test('конвертер читает минимальный Blockbench JSON для обеих моделей', () => {
  const input = { name: 'step', animation_length: '1', loop: 'loop', animators: {
    uuid: { name: 'RightLeg', keyframes: [
      { channel: 'position', time: '0', data_points: [{ x: '0', y: '0', z: '0' }] },
      { channel: 'position', time: '0.5', data_points: [{ x: '0', y: '0', z: '2' }] },
    ] }
  } };
  for (const model of ['classic', 'slim']) {
    const animation = convertBlockbenchAnimation(input, model);
    assert.equal(animation.name, 'step');
    assert.equal(animation.duration, 1);
    assert.equal(animation.loop, true);
    assert.ok(frame(BoneIndex.RightLeg, 0.5, animation).position[2] < 0);
  }
  assert.equal(BB_IDLE.name, 'bb_idle');
});

test('неподдерживаемые разрывы и step отклоняются', () => {
  for (const key of [
    { channel: 'position', time: 0, interpolation: 'step', data_points: [{ z: 1 }] },
    { channel: 'position', time: 0, data_points: [{ z: 1 }, { z: 2 }] },
  ]) assert.throws(() => convertBlockbenchAnimation({ name: 'bad', length: 1, bones: { Head: { keyframes: [key] } } }), /интерполяция|data_point/);
});

test('отсутствующая Head компенсирует движение Body, Z направлен правильно', () => {
  const animation = convertBlockbenchAnimation({ type: 'animation', content: { name: 'move', length: 1, loop: 'once', animators: {
    a: { name: 'Body', type: 'bone', rotation_global: false, keyframes: [
      { channel: 'position', time: 0, interpolation: 'linear', data_points: [{ x: 0, y: 0, z: 0 }] },
      { channel: 'position', time: 1, interpolation: 'linear', data_points: [{ x: 0, y: 0, z: -0.5 }] },
    ] }, waist: { name: 'waist', type: 'bone' }
  } } });
  assert.equal(animation.tracks.length, 6);
  const body = frame(BoneIndex.Body, 1, animation), head = frame(BoneIndex.Head, 1, animation);
  near(body.position[2], 0.5);
  vectorNear(sum(sum([0,24,0], body.position), rotate(body.rotation, head.position)), [0,24,0]);
});

test('ошибочные входные данные не игнорируются', () => {
  const base = keyframes => ({ name: 'bad', length: 1, animators: { a: { name: 'Head', keyframes } } });
  const key = { channel: 'position', time: 0, data_points: [{ x: 0, y: 0, z: 0 }] };
  for (const input of [
    { name: 'bad', length: 1, animators: { a: { name: 'unknown' } } },
    base([{ ...key, channel: 'scale' }]), base([{ ...key, data_points: [{ x: '' }] }]),
    base([{ ...key, data_points: [{ x: 'query.foo' }] }]),
    { ...base([]), loop: 'hold' }, base([key, key]), { name: 'bad', length: 1, bones: { Head: { position: {} } } },
    { name: 'bad', length: 1, animators: { a: { name: 'Head' }, b: { name: 'head' } } },
  ]) assert.throws(() => convertBlockbenchAnimation(input));
});
