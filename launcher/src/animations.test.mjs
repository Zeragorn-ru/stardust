import test from 'node:test';
import assert from 'node:assert/strict';
import { BoneIndex, quatFromEuler, quatMultiply, quatInvert, degToRad } from '@daidr/minecraft-skin-renderer';
import { IDLE_ANIMATIONS, SLIM_IDLE_ANIMATIONS, animationNameForModel, sampleCurve } from './animations.ts';

const near = (a, b, eps = 1e-7) => assert.ok(Math.abs(a-b) < eps, `${a} != ${b}`);
const vectorNear = (a, b) => { assert.equal(a.length, b.length); a.forEach((v, i) => near(v, b[i])); };
const rotate = (q, v) => quatMultiply(quatMultiply(q, [...v, 0]), quatInvert(q)).slice(0, 3);
const sum = (a, b) => a.map((v, i) => v + b[i]);
const delta = (a, b) => a.map((v, i) => v - b[i]);
const q = (x,y,z) => quatFromEuler(degToRad(x), degToRad(-y), degToRad(-z));
const clip = IDLE_ANIMATIONS[0];
function frame(bone, seconds, animation = clip) {
  const frames = animation.tracks.find(t => t.boneIndex === bone).keyframes;
  return frames.find(f => Math.abs(f.time * animation.duration - seconds) < 1e-10);
}

test('Catmull–Rom follows Blockbench SplineCurve endpoints and unequal timing', () => {
  const points = [[0,0,0,0],[1,2,0,0],[3,0,0,0]];
  near(sampleCurve(points, 0.5)[0], 1.125);
  near(sampleCurve(points, 2)[0], 1.125);
  near(sampleCurve(points, 1)[0], 2);
  near(sampleCurve(points, 4)[0], 0);
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
    [BoneIndex.Head, q(0,-68,0), [0,24,0], [-0.4,0.2,0.4]],
    [BoneIndex.RightArm, q(-1.0863,-22.9965,2.9245), [-6,24,0], [0,0,2.6]],
    [BoneIndex.RightLeg, q(-4.9019,-21.5223,6.387), [-2,12,0], [-1.11,0.16,2.45]],
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
  // Эталон рассчитан напрямую по XYZ Euler-матрицам, без функций renderer.
  const cases = [
    [clip, 6, [[-5.8253991144128445,24.05468825380674,2.911404048777629], [5.1958198687913235,24.025867852204186,-1.5123769919137195]]],
    [SLIM_IDLE_ANIMATIONS[0], 5.5, [[-5.3657341878929055,24.02548438414554,2.716839690982499], [4.742245124044065,24.01030654194955,-1.3025489753129365]]],
  ];
  for (const [animation, width, expected] of cases) {
    const body = frame(BoneIndex.Body, 0.5, animation);
    for (const [i, bone] of [BoneIndex.RightArm, BoneIndex.LeftArm].entries()) {
      const arm = frame(bone, 0.5, animation);
      const rest = [i === 0 ? -width : width, 0, 0];
      const world = sum(sum([0,24,0], body.position), rotate(body.rotation, sum(rest, arm.position)));
      vectorNear(world, expected[i]);
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
