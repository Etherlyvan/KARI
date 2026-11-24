import { CHARACTER_STATES, type CharacterState, type Direction } from './companion/types.js';

/** Authored pixel art: no source image, network, animation timer or rendering dependency. */
export type PixelState = 'idle' | 'think' | 'talk' | 'happy' | 'error';
export interface PixelPose {
  state: PixelState; blink?: boolean; frame?: number; glitch?: boolean; lifted?: boolean;
  behavior?: CharacterState; progress?: number; gaze?: Direction; lean?: Direction; offsetY?: number; facing?: Direction;
}
export interface PixelFrame { width: 48; height: 72; pixels: Uint8Array; palette: readonly string[]; }

export const PIXEL_PALETTE: readonly string[] = Object.freeze([
  '#00000000', // transparent
  '#160b22',   // outline
  '#2d193d',   // body
  '#593363',   // illuminated purple
  '#21102f',   // dark purple
  '#ff007b',   // magenta hair
  '#ff45a6',   // hair highlight
  '#b60057',   // hair shadow
  '#35ff99',   // green expression/core
  '#b5ffd9',   // green highlight
  '#137d58',   // green shade
  '#fff1fa',   // specular pixel
  '#710038',   // deep hair shadow
  '#e52180',   // pink clothing accent
  '#100a19',   // face recess
]);

const WIDTH = 48;
const HEIGHT = 72;
const STATES: PixelState[] = ['idle', 'think', 'talk', 'happy', 'error'];
type Point = readonly [number, number];
const progressStep = (value?: number) => Number.isFinite(value) ? Math.round(Math.max(0, Math.min(1, value!)) * 7) : 0;
const direction = (value?: number): Direction => value === -1 || value === 1 ? value : 0;
const offsetStep = (value?: number) => Number.isFinite(value) ? Math.max(-3, Math.min(3, Math.round(value!))) : 0;

function poseKey(pose: PixelPose): string {
  const state = STATES.includes(pose.state) ? pose.state : 'idle';
  const frame = Number.isFinite(pose.frame) ? ((Math.floor(pose.frame!) % 16) + 16) % 16 : 0;
  const behavior = pose.behavior && CHARACTER_STATES.includes(pose.behavior) ? pose.behavior : '';
  return `${state}:${pose.blink === true ? 1 : 0}:${frame}:${pose.glitch === true ? 1 : 0}:${pose.lifted === true ? 1 : 0}:${behavior}:${progressStep(pose.progress)}:${direction(pose.gaze)}:${direction(pose.lean)}:${offsetStep(pose.offsetY)}:${direction(pose.facing)}`;
}

/** A transparent 48×72 palette-index frame. Every coordinate is an integer pixel. */
export function buildPixelFrame(pose: PixelPose): PixelFrame {
  const behavior = pose.behavior && CHARACTER_STATES.includes(pose.behavior) ? pose.behavior : undefined;
  const progress = progressStep(pose.progress) / 7;
  const sleeping = behavior === 'SLEEP' || behavior === 'SLEEP_TALK' || (behavior === 'WAKE_UP' && progress < 0.3);
  const wakingSeated = behavior === 'WAKE_UP' && progress >= 0.3 && progress < 0.65;
  const seated = sleeping || wakingSeated;
  const sleepy = behavior === 'YAWN' || behavior === 'BORED';
  const walking = behavior === 'WALK' || behavior === 'RUN';
  const dancing = behavior === 'DANCE';
  const playing = behavior === 'PLAY';
  const landed = behavior === 'LANDED';
  const mappedState: PixelState = behavior === 'THINKING' ? 'think' : behavior === 'TALK' ? 'talk' : behavior === 'HAPPY' || dancing || playing ? 'happy' : 'idle';
  const state = behavior ? mappedState : STATES.includes(pose.state) ? pose.state : 'idle';
  const cycle = landed ? 0 : Number.isFinite(pose.frame) ? ((Math.floor(pose.frame!) % 16) + 16) % 16 : 0;
  const phase = cycle % 4;
  const sleepPhase = cycle % 8;
  // Sleep uses a slow local breath: the folded feet and supporting arms stay
  // planted while the chest, cheek and loose hair settle by one pixel.
  const chestLift = sleeping && sleepPhase >= 2 && sleepPhase <= 4 ? -1 : 0;
  const cheekLift = sleeping && (sleepPhase === 3 || sleepPhase === 4) ? -1 : 0;
  const lockSettle = sleeping && (sleepPhase === 5 || sleepPhase === 6) ? 1 : 0;
  const lifted = pose.lifted === true || behavior === 'DRAGGED';
  const localGaze = direction(pose.gaze) * (pose.facing === -1 ? -1 : 1);
  const idleLook = !lifted && behavior === 'LOOK_AROUND' ? localGaze || (phase < 2 ? -1 : 1) : !behavior && !lifted && state === 'idle' ? cycle >= 3 && cycle <= 5 ? -1 : cycle >= 6 && cycle <= 7 ? 1 : 0 : 0;
  const idleWink = !behavior && !lifted && state === 'idle' && cycle === 8;
  const idleWave = !lifted && ((dancing && phase % 2 === 0) || (!behavior && state === 'idle' && cycle >= 9 && cycle <= 11));
  const idleStretch = !lifted && (behavior === 'STRETCH' || (behavior === 'WAKE_UP' && progress >= 0.65) || (!behavior && state === 'idle' && cycle >= 12 && cycle <= 13));
  const pixels = new Uint8Array(WIDTH * HEIGHT);
  const bob = sleeping || landed || lifted ? 0 : dancing ? [0, -2, 0, -1][phase] : idleStretch ? -1 : [0, 0, -1, 0][phase];
  const hairSway = sleeping || landed || lifted || behavior === 'IDLE' ? 0 : [0, 1, 0, -1][phase];
  const headX = lifted ? 0 : sleeping ? 2 : behavior === 'CURIOUS' ? -1 : behavior === 'LISTEN' ? 1 : state === 'think' || state === 'error' ? -1 : idleLook || (behavior ? localGaze : 0);
  const headY = sleeping ? 2 : sleepy ? 1 : lifted || idleStretch || behavior === 'CURIOUS' ? -1 : state === 'error' ? 1 : 0;
  const coreColor = sleeping ? 10 : lifted || dancing || (state === 'idle' && cycle >= 10 && cycle <= 13 && !behavior) ? 9 : 8;

  const pixel = (x: number, y: number, color: number) => {
    if (x >= 0 && x < WIDTH && y >= 0 && y < HEIGHT) pixels[y * WIDTH + x] = color;
  };
  const rect = (x: number, y: number, width: number, height: number, color: number) => {
    for (let row = y; row < y + height; row++) for (let column = x; column < x + width; column++) pixel(column, row, color);
  };
  const line = (start: Point, end: Point, color: number, width = 1) => {
    let [x, y] = start;
    const dx = Math.abs(end[0] - x); const sx = x < end[0] ? 1 : -1;
    const dy = -Math.abs(end[1] - y); const sy = y < end[1] ? 1 : -1;
    let error = dx + dy;
    while (true) {
      if (width === 1) pixel(x, y, color); else rect(x - Math.floor(width / 2), y - Math.floor(width / 2), width, width, color);
      if (x === end[0] && y === end[1]) break;
      const next = 2 * error;
      if (next >= dy) { error += dy; x += sx; }
      if (next <= dx) { error += dx; y += sy; }
    }
  };
  const polygon = (points: readonly Point[], color: number, offsetX = 0, offsetY = bob) => {
    const shifted = points.map(([x, y]) => [x + offsetX, y + offsetY] as const);
    const minimum = Math.max(0, Math.min(...shifted.map(point => point[1])));
    const maximum = Math.min(HEIGHT - 1, Math.max(...shifted.map(point => point[1])));
    for (let y = minimum; y <= maximum; y++) {
      const intersections: number[] = [];
      for (let index = 0; index < shifted.length; index++) {
        const a = shifted[index]; const b = shifted[(index + 1) % shifted.length];
        const center = y + 0.5;
        if ((a[1] <= center && b[1] > center) || (b[1] <= center && a[1] > center)) intersections.push(a[0] + (center - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
      }
      intersections.sort((a, b) => a - b);
      for (let index = 0; index + 1 < intersections.length; index += 2) {
        for (let x = Math.ceil(intersections[index] - 0.5); x < intersections[index + 1] - 0.5; x++) pixel(x, y, color);
      }
    }
  };
  const head = (points: readonly Point[], color: number) => polygon(points, color, headX, bob + headY);
  const dot = (x: number, y: number, color: number) => pixel(x + headX, y + bob + headY, color);
  // A shoulder/back grip supports the body. Only the weight below it trails
  // the pointer; the shared face and mane are never warped by carrying.
  const carryLag = -direction(pose.lean) * (pose.facing === -1 ? -1 : 1);
  const carrySwing = [0, 1, 0, -1][phase];
  const carryPoint = ([x, y]: Point): Point => [x + Math.round(carryLag * Math.max(0, y - 32) / 18) + (y >= 50 ? Math.round(carrySwing * (y - 50) / 22) : 0), y];
  const body = (points: readonly Point[], color: number) => polygon(lifted ? points.map(carryPoint) : points, color);
  const bodyPixel = (x: number, y: number, color: number) => { const point = lifted ? carryPoint([x, y]) : [x, y]; pixel(point[0]!, point[1]! + bob, color); };

  // A broad, asymmetric mane: pointed crown, two long trailing locks, broken silhouette.
  const drawMane = (paint: (points: readonly Point[], color: number) => void) => {
    paint([[18, 10], [21, 3], [23, 7], [29, 5], [28, 9], [38, 7], [34, 12], [41, 15], [37, 17], [46, 23], [39, 22], [45, 30], [37, 27], [41, 41], [34, 35], [37, 48], [30, 41], [30, 53], [25, 45], [18, 48], [18, 40], [8, 49], [12, 35], [3, 41], [9, 27], [1, 30], [9, 20], [5, 20], [14, 14], [11, 12]], 5);
    paint([[30, 15], [37, 19], [34, 23], [39, 35], [32, 29], [35, 43], [29, 37], [28, 46], [25, 39]], 7);
    paint([[14, 21], [16, 27], [10, 43], [15, 35], [13, 44], [20, 36], [18, 25]], 7);
    paint([[31, 12], [37, 10], [32, 15], [39, 17], [31, 17]], 6);
    paint([[11, 21], [18, 14], [17, 21], [6, 33]], 6);
    paint([[29, 33], [33, 36], [33, 43], [30, 39]], 12);
  };
  drawMane((points, color) => polygon(points, color, hairSway));

  // Neck, fitted torso and hips, edged in purple so the dark body reads on black.
  body([[22, 27], [27, 27], [27, 32], [23, 34], [21, 31]], 3);
  body([[20, 31], [23, 30], [27, 30], [30, 33], [28, 39], [29, 44], [25, 48], [20, 45], [21, 39], [18, 34]], 1);
  body([[21, 32], [25, 32], [28, 34], [26, 39], [27, 43], [24, 45], [21, 42], [23, 38], [20, 35]], 2);
  body([[21, 32], [23, 32], [23, 38], [21, 40], [21, 35]], 3);
  body([[26, 33], [29, 34], [27, 39], [25, 38]], 4);
  body([[22, 31], [24, 33], [27, 31], [26, 34], [23, 35]], 8);
  body([[23, 34], [26, 35], [25, 39], [23, 41], [22, 37]], coreColor);
  bodyPixel(24, 35, 9); bodyPixel(24, 36, 9);
  body([[21, 42], [25, 44], [28, 42], [27, 46], [24, 48], [20, 45]], 3);
  if (lifted) {
    line([20, 31], [23, 30], 3); line([27, 30], [29, 31], 3);
    line([20, 33], [22, 32], 13); line([27, 32], [29, 33], 13);
    line(carryPoint([21, 44]), carryPoint([25, 46]), 13);
  } else line([21, 44 + bob], [25, 46 + bob], 13);

  // Lifted limbs hang beneath the grasp; normal floating legs keep a bent silhouette.
  if (seated) {
    // Bent thighs and overlapping boots form a compact seated/curl silhouette.
    polygon([[21, 44], [25, 46], [20, 51], [16, 52], [18, 54], [25, 54], [28, 51], [29, 47], [27, 44]], 1);
    polygon([[21, 46], [24, 47], [20, 51], [17, 52], [22, 52], [26, 49], [27, 46]], 3);
    polygon([[27, 45], [30, 47], [33, 52], [31, 56], [23, 57], [20, 55], [24, 53], [29, 53], [26, 49]], 1);
    polygon([[28, 48], [31, 52], [30, 54], [24, 55], [23, 54], [29, 52], [27, 49]], 3);
    polygon([[16, 51], [20, 51], [23, 53], [21, 55], [17, 54]], 5);
    polygon([[28, 53], [32, 52], [31, 55], [25, 56], [24, 54]], 5);
    pixel(19, 52 + bob, 8); pixel(29, 54 + bob, 8);
  } else if (walking || dancing || playing) {
    const stride = behavior === 'RUN' ? [-8, -2, 8, 2][phase] : walking ? [-5, 0, 5, 0][phase] : dancing ? [-4, 3, 4, -3][phase] : playing ? [-3, -1, 3, 1][phase] : -4;
    const bend = playing ? 3 : 0;
    const leftHip: Point = [22, 45 + bob]; const rightHip: Point = [26, 45 + bob];
    const leftKnee: Point = [20 + Math.trunc(stride / 2), 54 + bob - bend];
    const rightKnee: Point = [28 - Math.trunc(stride / 2), 54 + bob - bend];
    const leftFoot: Point = [20 + stride, 66 + bob - (stride > 0 ? walking ? 5 : 3 : 0) - bend];
    const rightFoot: Point = [27 - stride, 66 + bob - (stride < 0 ? walking ? 5 : 3 : 0) - bend];
    for (const [hip, knee, foot] of [[leftHip, leftKnee, leftFoot], [rightHip, rightKnee, rightFoot]] as const) {
      line(hip, knee, 1, 4); line(knee, foot, 1, 4);
      line(hip, knee, 3, 2); line(knee, foot, 5, 2);
      rect(foot[0] - 1, foot[1], 4, 2, 5); pixel(knee[0], knee[1], 8);
    }
  } else if (lifted) {
    body([[21, 44], [24, 46], [23, 54], [22, 60], [22, 67], [20, 70], [18, 69], [20, 58], [19, 51]], 1);
    body([[21, 47], [23, 48], [22, 54], [21, 60], [21, 65], [20, 67], [21, 56]], 3);
    body([[20, 57], [22, 56], [22, 65], [20, 70], [19, 69]], 5);
    body([[25, 45], [28, 44], [29, 53], [28, 59], [29, 68], [27, 70], [25, 61], [24, 53]], 1);
    body([[26, 47], [27, 47], [27, 55], [27, 60], [28, 66], [27, 66], [25, 56]], 3);
    body([[27, 57], [28, 56], [28, 63], [29, 69], [27, 69]], 5);
    bodyPixel(21, 57, 8); bodyPixel(27, 57, 8);
  } else {
    polygon([[21, 44], [25, 46], [23, 54], [21, 61], [19, 68], [16, 70], [18, 61], [19, 53], [19, 48]], 1);
    polygon([[21, 46], [23, 47], [21, 55], [20, 61], [18, 66], [19, 57]], 3);
    polygon([[20, 54], [22, 53], [21, 61], [17, 69], [18, 62]], 5);
    polygon([[25, 46], [28, 44], [29, 50], [28, 56], [27, 63], [27, 68], [25, 65], [24, 57], [25, 52]], 1);
    polygon([[26, 47], [27, 47], [27, 54], [26, 59], [25, 55]], 3);
    polygon([[27, 54], [29, 52], [28, 59], [27, 66], [26, 64]], 5);
    pixel(20, 54 + bob, 8); pixel(27, 54 + bob, 8);
    pixel(19, 63 + bob, 6); pixel(27, 62 + bob, 6);
  }

  // Hands change pose rather than translating the entire character as a rigid sticker.
  if (sleeping || wakingSeated) {
    polygon([[20, 32], [18, 34], [18, 38], [21, 41], [25, 42], [26, 40], [22, 38], [21, 34]], 1);
    polygon([[20, 34], [20, 37], [23, 39], [25, 40], [24, 41], [20, 39], [19, 36]], 3);
    rect(23, 40 + bob, 3, 2, 8);
  } else if (behavior === 'YAWN' || behavior === 'BORED' || behavior === 'LISTEN') {
    const handY = behavior === 'LISTEN' ? 23 : behavior === 'BORED' ? 29 : 27;
    const elbowY = behavior === 'LISTEN' ? 28 : 32;
    polygon([[20, 32], [18, 34], [14, elbowY + 1], [14, elbowY - 1], [17, handY], [20, handY], [19, handY + 3], [17, elbowY], [20, 30]], 1);
    polygon([[18, 32], [16, elbowY], [16, elbowY - 1], [18, handY + 2], [19, handY + 2], [17, elbowY]], 3);
    rect(17, handY + bob, 3, 2, 8);
  } else if (walking || playing) {
    const raised = phase < 2;
    const shoulder: Point = [19, 33 + bob]; const elbow: Point = raised ? [15, 36 + bob] : [17, 38 + bob];
    const hand: Point = raised ? [14, 31 + bob] : [20, 41 + bob];
    line(shoulder, elbow, 1, 3); line(elbow, hand, 1, 3);
    line(shoulder, elbow, 3); line(elbow, hand, 13);
    rect(hand[0], hand[1], 2, 2, 8);
  } else if (lifted) {
    body([[19, 30], [21, 33], [18, 36], [17, 40], [17, 44], [15, 44], [14, 40], [15, 35], [16, 31]], 1);
    body([[18, 32], [19, 33], [17, 36], [16, 40], [16, 42], [15, 40], [16, 35]], 3);
    body([[15, 40], [17, 41], [17, 43], [15, 43]], 13);
    bodyPixel(15, 43, 8); bodyPixel(16, 43, 8); bodyPixel(15, 44, 8); bodyPixel(17, 44, 8);
  } else if (idleStretch) {
    polygon([[20, 32], [17, 33], [13, 30], [11, 25], [12, 22], [15, 21], [17, 24], [15, 27], [17, 29], [21, 30]], 1);
    polygon([[18, 31], [14, 29], [13, 25], [14, 24], [15, 28], [19, 30]], 3);
    rect(12, 22 + bob, 3, 3, 8); pixel(12, 21 + bob, 9);
  } else if (state === 'think') {
    polygon([[20, 32], [18, 35], [14, 34], [14, 31], [17, 27], [20, 27], [19, 30], [17, 32], [20, 30]], 1);
    polygon([[18, 33], [16, 33], [16, 31], [18, 29], [19, 29], [17, 32]], 3);
    polygon([[17, 29], [18, 27], [20, 28], [19, 30]], 8);
    pixel(18, 28 + bob, 9);
  } else if (state === 'happy') {
    polygon([[20, 32], [18, 33], [14, 29], [12, 25], [13, 22], [16, 23], [17, 27], [20, 29]], 1);
    polygon([[18, 31], [15, 28], [14, 25], [15, 25], [17, 28], [20, 30]], 3);
    rect(13, 23 + bob, 3, 3, 8); pixel(12, 22 + bob, 8); pixel(14, 22 + bob, 9);
  } else {
    polygon([[19, 32], [21, 34], [18, 38], [18, 41], [19, 43], [17, 44], [15, 41], [15, 38]], 1);
    polygon([[19, 34], [19, 35], [17, 38], [17, 41], [16, 40], [16, 38]], 3);
    polygon([[17, 40], [18, 41], [18, 43], [17, 43], [16, 42]], 13);
    pixel(17, 42 + bob, 8);
  }
  if (sleeping || wakingSeated) {
    polygon([[28, 32], [31, 34], [32, 38], [29, 42], [25, 43], [24, 41], [28, 38], [28, 35]], 1);
    polygon([[29, 34], [30, 37], [28, 40], [26, 41], [28, 41], [31, 38]], 3);
    rect(25, 41 + bob, 3, 2, 8);
  } else if (behavior === 'CURIOUS') {
    polygon([[28, 32], [31, 33], [32, 37], [29, 39], [25, 38], [26, 36], [29, 36], [28, 34]], 1);
    line([29, 34 + bob], [30, 36 + bob], 3, 2); rect(25, 36 + bob, 3, 2, 8);
  } else if (walking || playing) {
    const raised = phase >= 2;
    const shoulder: Point = [29, 33 + bob]; const elbow: Point = raised ? [33, 35 + bob] : [32, 38 + bob];
    const hand: Point = raised ? [35, 30 + bob] : [29, 41 + bob];
    line(shoulder, elbow, 1, 3); line(elbow, hand, 1, 3);
    line(shoulder, elbow, 3); line(elbow, hand, 13); rect(hand[0], hand[1], 2, 2, 8);
  } else if (lifted) {
    body([[28, 30], [31, 31], [33, 35], [34, 40], [33, 44], [31, 44], [31, 40], [30, 36], [28, 33]], 1);
    body([[29, 32], [31, 35], [32, 40], [32, 42], [31, 40], [30, 36]], 3);
    body([[31, 41], [33, 40], [33, 43], [31, 43]], 13);
    bodyPixel(31, 43, 8); bodyPixel(32, 43, 8); bodyPixel(31, 44, 8); bodyPixel(33, 44, 8);
  } else if (idleStretch) {
    polygon([[28, 32], [31, 29], [34, 27], [32, 24], [33, 21], [36, 22], [37, 25], [36, 30], [32, 34], [29, 35]], 1);
    polygon([[30, 32], [34, 29], [35, 26], [34, 24], [35, 24], [36, 28], [32, 33]], 3);
    rect(33, 22 + bob, 3, 3, 8); pixel(34, 21 + bob, 9);
  } else if (idleWave) {
    const handLift = [0, -1, 0, 1][phase];
    polygon([[28, 32], [30, 31], [33, 33], [35, 29 + handLift], [35, 25 + handLift], [38, 25 + handLift], [39, 29 + handLift], [36, 34], [32, 36], [29, 35]], 1);
    polygon([[30, 33], [32, 34], [35, 30 + handLift], [36, 28 + handLift], [37, 28 + handLift], [36, 32], [33, 35]], 3);
    rect(35, 26 + handLift + bob, 3, 3, 8);
    pixel(38, 25 + handLift + bob, 8); pixel(36, 24 + handLift + bob, 9);
  } else if (state === 'talk' || state === 'happy') {
    const handLift = state === 'happy' ? -1 : phase === 1 || phase === 2 ? 0 : 1;
    polygon([[28, 32], [30, 31], [32, 32], [34, 28 + handLift], [36, 27 + handLift], [37, 29 + handLift], [34, 34], [31, 35], [29, 35]], 1);
    polygon([[29, 33], [31, 33], [34, 30 + handLift], [35, 29 + handLift], [34, 32], [32, 34]], 3);
    rect(34, 27 + handLift + bob, 3, 3, 8);
    pixel(37, 27 + handLift + bob, 8); pixel(35, 26 + handLift + bob, 9);
  } else {
    polygon([[28, 32], [30, 33], [33, 38], [32, 41], [31, 44], [29, 43], [30, 39], [28, 37], [27, 35]], 1);
    polygon([[29, 34], [31, 38], [31, 41], [30, 42], [30, 39], [28, 35]], 3);
    polygon([[31, 39], [32, 41], [31, 43], [30, 43]], 13);
    pixel(31, 42 + bob, 8);
  }

  // Head and asymmetrical fringe. The near-black eye recess makes neon pixels crisp.
  const drawFace = (paint = head, ink = dot, drowsy = false) => {
  const head = paint, dot = ink;
  head([[20, 15], [25, 14], [30, 17], [31, 23], [28, 29], [23, 31], [18, 27], [17, 21]], 1);
  head([[21, 17], [26, 16], [29, 19], [29, 24], [26, 28], [22, 28], [19, 25], [19, 20]], 2);
  head([[18, 20], [21, 18], [22, 23], [20, 26], [18, 24]], 4);
  head([[26, 18], [29, 19], [30, 23], [27, 26], [26, 23]], 14);
  head([[17, 16], [21, 10], [27, 10], [33, 16], [30, 20], [31, 25], [27, 21], [26, 16], [23, 20], [21, 22], [21, 17], [18, 21], [16, 26], [15, 21], [12, 24]], 5);
  head([[21, 12], [25, 11], [22, 16], [19, 19]], 6);
  head([[29, 15], [32, 17], [30, 20], [31, 24], [28, 20]], 7);

  if (pose.blink === true || behavior === 'BLINK' || sleeping) {
    const lid = sleeping ? 10 : 8;
    dot(20, 23, lid); dot(21, 23, lid); dot(22, 22, lid);
    dot(26, 22, lid); dot(27, 23, lid); dot(28, 23, lid);
  } else if (sleepy || wakingSeated || drowsy) {
    dot(19, 22, 10); dot(20, 22, 8); dot(21, 22, 8); dot(22, 22, 10);
    dot(26, 22, 10); dot(27, 22, 8); dot(28, 22, 8); dot(29, 22, 10);
  } else if (lifted) {
    // The same narrow neon eyes as the main sprite, tightened in surprise.
    dot(19, 22, 8); dot(20, 23, 8); dot(21, 23, 9); dot(22, 22, 8);
    dot(26, 22, 8); dot(27, 22, 9); dot(28, 21, 8); dot(29, 20, 8);
    dot(19, 25, 13); dot(21, 25, 13); dot(28, 25, 13);
  } else if (idleWink) {
    dot(19, 23, 8); dot(20, 22, 8); dot(21, 22, 8); dot(22, 23, 8);
    dot(26, 21, 8); dot(27, 22, 9); dot(28, 22, 8); dot(29, 20, 8); dot(29, 21, 8);
  } else if (state === 'happy') {
    dot(19, 23, 8); dot(20, 22, 9); dot(21, 22, 8); dot(22, 23, 8);
    dot(26, 23, 8); dot(27, 22, 9); dot(28, 22, 8); dot(29, 23, 8);
  } else if (state === 'error') {
    dot(20, 22, 8); dot(21, 23, 8); dot(22, 22, 8); dot(20, 24, 8); dot(22, 24, 8);
    dot(26, 22, 8); dot(27, 23, 8); dot(28, 22, 8); dot(26, 24, 8); dot(28, 24, 8);
  } else {
    const gaze = idleLook || (behavior ? localGaze : 0);
    dot(19 + gaze, 22, 8); dot(20 + gaze, 23, 8); dot(21 + gaze, 23, 9); dot(22 + gaze, 22, 8); dot(22 + gaze, 21, 8);
    dot(26 + gaze, 21, 8); dot(27 + gaze, 22, 9); dot(28 + gaze, 22, 8); dot(29 + gaze, 20, 8); dot(29 + gaze, 21, 8);
    if (state === 'think') { dot(20, 21, 10); dot(26, 20, 10); }
    if (behavior === 'CURIOUS') { dot(20, 19, 8); dot(21, 19, 8); dot(22, 20, 8); }
    if (behavior === 'LISTEN') { dot(20, 21, 9); dot(27, 20, 9); }
  }
  if (behavior === 'YAWN' && progress > 0.1 && progress < 0.9) {
    dot(23, 26, 8); dot(24, 25, 8); dot(25, 25, 8); dot(26, 26, 8);
    dot(23, 27, 8); dot(26, 27, 8); dot(24, 28, 9); dot(25, 28, 8);
  } else if (behavior === 'SLEEP_TALK') {
    dot(24, 27, 10);
    if (phase === 1 || phase === 2) { dot(25, 27, 8); dot(24, 28, 10); }
  } else if (sleeping) {
    dot(24, 27, 10); dot(25, 27, 10);
  } else if (behavior === 'BORED') {
    dot(23, 27, 10); dot(24, 27, 8); dot(25, 27, 8); dot(26, 27, 10);
  } else if (lifted || (state === 'talk' && phase % 2 === 0)) {
    dot(24, 26, 8); dot(25, 26, 8); dot(24, 27, 9); dot(25, 27, 8);
  } else if (state === 'error') {
    dot(23, 28, 10); dot(24, 27, 8); dot(25, 27, 8); dot(26, 28, 10);
  } else {
    dot(23, 26, 10); dot(24, 27, 8); dot(25, 27, 9); dot(26, 26, 8);
  }
  };
  drawFace();

  if (sleeping) {
    pixels.fill(0);
    // Repose the same pointed mane, its dark locks and highlights together.
    const manePoint = ([x, y]: Point): Point => [18 + Math.round((x - 24) * .72 - (y - 25) * .14), 49 + Math.round((y - 25) * .60 + (x - 24) * .12) + (y <= 31 ? cheekLift : y >= 35 ? lockSettle : 0)];
    drawMane((points, color) => polygon(points.map(manePoint), color, 0, 0));
    // Keep the fitted torso, diagonal green core and tapered folded boots.
    const chest = (points: readonly Point[], color: number) => polygon(points.map(([x, y]) => [x, y + (y <= 55 ? chestLift : 0)] as const), color, 0, 0);
    chest([[24, 51], [28, 50], [33, 54], [36, 58], [34, 62], [29, 61], [25, 57]], 1);
    chest([[26, 52], [28, 52], [31, 55], [34, 58], [33, 60], [29, 59], [26, 56]], 2);
    chest([[27, 52], [29, 53], [32, 56], [31, 58], [28, 55]], 3);
    chest([[26, 53], [28, 54], [29, 53], [30, 55], [28, 56], [27, 58], [26, 56]], sleeping ? 10 : 8);
    const coreHighlight = sleeping ? (sleepPhase === 2 || sleepPhase === 3 ? 8 : 10) : 9;
    pixel(28, 54 + chestLift, coreHighlight);
    polygon([[33, 58], [37, 55], [42, 56], [44, 60], [40, 63], [34, 63], [32, 61]], 1, 0, 0);
    polygon([[35, 58], [38, 57], [41, 58], [42, 60], [38, 61], [34, 61]], 3, 0, 0);
    polygon([[34, 61], [39, 61], [38, 63], [30, 65], [27, 64]], 5, 0, 0);
    pixel(36, 62, sleeping ? 10 : 8);
    polygon([[34, 61], [38, 60], [44, 63], [43, 66], [37, 68], [32, 67], [38, 65], [40, 64]], 1, 0, 0);
    polygon([[36, 62], [39, 62], [42, 64], [39, 66], [35, 66], [39, 64]], 3, 0, 0);
    polygon([[34, 65], [39, 65], [38, 67], [31, 68], [28, 67]], 5, 0, 0);
    pixel(37, 66, sleeping ? 10 : 8);
    // The exact original mask and asymmetric fringe tilt onto the forearms.
    const facePoint = ([x, y]: Point): Point => [17 + Math.round((x - 24) * .95 + (y - 23) * .25), 51 + Math.round((y - 23) * .94 - (x - 24) * .25) + cheekLift];
    drawFace((points, color) => polygon(points.map(facePoint), color, 0, 0), (x, y, color) => { const point = facePoint([x, y]); pixel(point[0], point[1], color); }, true);
    line([27, 55 + chestLift], [25, 60], 1, 3); line([25, 60], [17, 60], 3, 2);
    line([25, 57], [24, 63], 1, 3); line([24, 63], [15, 62], 3, 2);
    rect(14, 61, 3, 2, sleeping ? 10 : 8); pixel(17, 62, 10);
  }

  // Few intentionally placed detached pixels suggest a digital aura, not noisy particles.
  const particlePhase = behavior === 'IDLE' || lifted ? 0 : phase % 2;
  if (!sleeping) {
    rect(7 + particlePhase, 11 + bob, 2, 2, 7);
    rect(39 - particlePhase, 34 + bob, 2, 3, 5);
  }
  if (!seated) {
    rect(9, 53 - particlePhase, 2, 3, 5);
    pixel(10, 53 - particlePhase, 8);
    rect(34, 60 + particlePhase, 1, 3, 7);
  }
  if (state === 'think') { rect(36, 11 + bob, 2, 2, 8); rect(39, 9 + bob, 2, 2, 8); rect(42, 11 + bob, 2, 2, 8); }
  if (state === 'happy') { pixel(8, 20 + bob, 8); pixel(7, 21 + bob, 8); pixel(9, 21 + bob, 8); pixel(8, 22 + bob, 8); }
  if (idleWave) { pixel(40, 27 + bob, 8); pixel(41, 26 + bob, 8); }
  if (idleStretch) { pixel(10, 24 + bob, 8); pixel(9, 25 + bob, 8); }

  if (sleeping) {
    // Stagger the glyph ages: each Z rises, dims into the existing shadow
    // green and disappears before the next one is born. No opacity/blur pass.
    if (behavior === 'SLEEP_TALK') {
      for (let index = 0; index < 3; index++) if (index <= phase) rect(29 + index * 4, 32 - Number(phase >= 2), 2, 2, phase === 3 ? 10 : 8);
    } else {
      const glyph = ['111', '001', '010', '100', '111'];
      pixel(28, 38, 10);
      for (let index = 0; index < 3; index++) {
        const age = (sleepPhase + index * 3) % 8;
        if (age === 0 || age === 7) continue;
        const left = 29 + age * 2, top = 37 - age * 3;
        const color = age >= 4 ? 10 : 8;
        for (let y = 0; y < glyph.length; y++) for (let x = 0; x < 3; x++) if (glyph[y][x] === '1') pixel(left + x, top + y, color);
      }
    }
  }
  if (dancing) {
    const lift = [0, -2, 0, 2][phase];
    pixel(9, 32 + lift, 8); pixel(8, 33 + lift, 8); pixel(10, 33 + lift, 8); pixel(9, 34 + lift, 8);
    rect(39, 42 - lift, 2, 2, 5); pixel(38, 43 - lift, 8); pixel(41, 43 - lift, 8);
  }
  if (playing) {
    const ballY = [37, 31, 35, 40][phase];
    rect(37, ballY, 4, 4, 7); rect(38, ballY, 2, 3, 8); pixel(38, ballY + 1, 9);
    pixel(35, ballY + 4, 5); pixel(34, ballY + 5, 7);
  }

  if (behavior || pose.facing || pose.lean || pose.offsetY) {
    const source = pixels.slice(); pixels.fill(0);
    const mirror = direction(pose.facing) === -1;
    const leaning = direction(pose.lean) || (behavior === 'RUN' ? mirror ? -1 : 1 : 0);
    const vertical = offsetStep(pose.offsetY);
    for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
      const color = source[y * WIDTH + x];
      if (!color) continue;
      // Carried limbs have already been posed around the shoulder grip above.
      const shift = lifted ? 0 : leaning * Math.round((44 - y) / 20);
      pixel((mirror ? WIDTH - 1 - x : x) + shift, y + vertical, color);
    }
  }

  if (pose.glitch === true) {
    const original = pixels.slice();
    const shifts = [[6, -5, 4], [-7, 6, -4], [5, -7, 6], [-4, 5, -6]][phase];
    const bands = [[18 + bob, 3, shifts[0]], [33 + bob, 3, shifts[1]], [45 + bob, 2, shifts[2]]];
    for (const [top, height, shift] of bands) {
      for (let row = top; row < top + height; row++) {
        pixels.fill(0, row * WIDTH, (row + 1) * WIDTH);
        for (let x = 0; x < WIDTH; x++) {
          const source = x - shift;
          if (source >= 0 && source < WIDTH) pixels[row * WIDTH + x] = original[row * WIDTH + source];
        }
        // Sparse color-separated echoes widen the torn silhouette without flashing white.
        for (let x = 0; x < WIDTH; x++) {
          const echo = x - shift;
          if ((x + row) % 3 === 0 && original[row * WIDTH + x] && echo >= 0 && echo < WIDTH && !pixels[row * WIDTH + echo]) pixel(echo, row, phase % 2 ? 5 : 8);
        }
      }
    }
    rect(38, 20 + bob, 7, 1, 8); rect(2, 34 + bob, 6, 2, 5);
    rect(34 + phase, 48 + bob, 5, 1, 5); rect(8 - phase, 27 + bob, 4, 1, 8);
  }
  return { width: WIDTH, height: HEIGHT, pixels, palette: PIXEL_PALETTE };
}

type CachedFrame = { frame: PixelFrame; image?: ImageData };
const rgba = PIXEL_PALETTE.map(hex => {
  const value = hex.slice(1);
  return [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16), value.length === 8 ? parseInt(value.slice(6, 8), 16) : 255] as const;
});

/** One canvas; at most 40 tiny cached frames. Caller owns visibility and animation timing. */
export class PixelKariRenderer {
  private readonly context: CanvasRenderingContext2D | null;
  private readonly frames = new Map<string, CachedFrame>();

  constructor(private readonly canvas: HTMLCanvasElement) {
    canvas.width = WIDTH; canvas.height = HEIGHT;
    let context: CanvasRenderingContext2D | null = null;
    try { context = canvas.getContext('2d'); } catch { /* No canvas API in some test/embedded environments. */ }
    this.context = context;
    if (context) context.imageSmoothingEnabled = false;
  }

  render(pose: PixelPose): void {
    const context = this.context;
    if (!context) return;
    const key = poseKey(pose);
    let entry = this.frames.get(key);
    if (!entry) {
      entry = { frame: buildPixelFrame(pose) };
      this.frames.set(key, entry);
      if (this.frames.size > 40) this.frames.delete(this.frames.keys().next().value!);
    } else {
      this.frames.delete(key); this.frames.set(key, entry);
    }
    if (!entry.image) {
      const image = context.createImageData(WIDTH, HEIGHT);
      for (let index = 0; index < entry.frame.pixels.length; index++) image.data.set(rgba[entry.frame.pixels[index]], index * 4);
      entry.image = image;
    }
    context.putImageData(entry.image, 0, 0);
  }
}
