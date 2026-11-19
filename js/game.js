import * as THREE from 'three';
import { Sim, ITEMS } from './sim.js';

THREE.ColorManagement.enabled = false;

// 건물 격자 정보 (정면도·측면도 분석 결과)
const GEO = { nx: 10, nz: 6, ny: 27, ch: 4.0, cw: 4.881, cd: 4.962 };
const R_PLAYER = 95;
const THROW_SPEED = 78; // 던지는 속도 (m/s) — 클수록 빨리 날아감

const $ = (s) => document.querySelector(s);
const canvas = $('#c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;

const scene = new THREE.Scene();
const FOG = new THREE.Color(0xe6cfab);
scene.background = FOG;
scene.fog = new THREE.Fog(FOG, 170, 540);
const camera = new THREE.PerspectiveCamera(70, 1, 0.5, 1500);

const loader = new THREE.TextureLoader();
const tex = (u) => new Promise((ok, no) => loader.load(u, ok, undefined, no));
const [tFront, tSide, tSky, tGround, ...tItems] = await Promise.all([
  tex('assets/front.jpg'), tex('assets/side.jpg'), tex('assets/sky.jpg'), tex('assets/ground.jpg'),
  ...ITEMS.map((_, i) => tex(`assets/item${i}.webp`)),
]);
for (const t of [tFront, tSide]) { t.anisotropy = 4; t.minFilter = THREE.LinearMipmapLinearFilter; }

// ── 하늘 · 땅 · 조명 ──────────────────────────────
tSky.wrapS = THREE.MirroredRepeatWrapping; tSky.repeat.set(3, 1);
const sky = new THREE.Mesh(
  new THREE.CylinderGeometry(560, 560, 620, 72, 1, true),
  new THREE.MeshBasicMaterial({ map: tSky, side: THREE.BackSide, fog: false, depthWrite: false })
);
sky.position.y = 280; sky.renderOrder = -1; scene.add(sky);

tGround.wrapS = tGround.wrapT = THREE.RepeatWrapping; tGround.repeat.set(54, 54);
const ground = new THREE.Mesh(new THREE.CircleGeometry(540, 64), new THREE.MeshBasicMaterial({ map: tGround, color: 0xd9d0c2 }));
ground.rotation.x = -Math.PI / 2; scene.add(ground);
const LIGHT_DIR = new THREE.Vector3(-0.45, 0.75, 0.5).normalize();

// 건물 아래 그림자 느낌
const shadowTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'); const gr = g.createRadialGradient(64, 64, 10, 64, 64, 64);
  gr.addColorStop(0, 'rgba(0,0,0,0.45)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
})();

// ── 건물 블록 (인스턴싱 + 정면/측면 텍스처 매핑) ─────────
const blockMat = new THREE.ShaderMaterial({
  uniforms: {
    uFront: { value: tFront }, uSide: { value: tSide },
    uGrid: { value: new THREE.Vector3(GEO.nx, GEO.ny, GEO.nz) },
    uLight: { value: LIGHT_DIR }, uFog: { value: FOG }, uFogNear: { value: 170 }, uFogFar: { value: 540 },
  },
  vertexShader: /* glsl */ `
    attribute vec3 aCell; attribute float aFaces;
    varying vec3 vLocal; varying vec3 vN; varying vec3 vNW; varying vec3 vCell; varying float vFaces; varying float vDepth; varying vec3 vWP;
    void main(){
      vLocal = position; vN = normal; vCell = aCell; vFaces = aFaces;
      mat4 m = modelMatrix * instanceMatrix;
      vec4 wp = m * vec4(position, 1.0); vWP = wp.xyz;
      vNW = normalize(mat3(m) * normal);
      vec4 mv = viewMatrix * wp; vDepth = -mv.z;
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D uFront, uSide; uniform vec3 uGrid, uLight, uFog; uniform float uFogNear, uFogFar;
    varying vec3 vLocal; varying vec3 vN; varying vec3 vNW; varying vec3 vCell; varying float vFaces; varying float vDepth; varying vec3 vWP;
    float bit(float f, float k){ return mod(floor(f / pow(2.0, k) + 0.001), 2.0); }
    float hash(vec3 p){ return fract(sin(dot(p, vec3(12.9898,78.233,37.719))) * 43758.5453); }
    void main(){
      vec3 p = vLocal + 0.5;
      float n = hash(floor(vWP * 1.7)) * 0.08;
      vec3 col = vec3(0.56, 0.54, 0.51) + n;           // 부서진 콘크리트 단면
      float v = (vCell.y + p.y) / uGrid.y;
      if (vN.z > 0.5 && bit(vFaces,0.0) > 0.5)       col = texture2D(uFront, vec2((vCell.x + p.x) / uGrid.x, v)).rgb;
      else if (vN.z < -0.5 && bit(vFaces,1.0) > 0.5) col = texture2D(uFront, vec2(1.0 - (vCell.x + p.x) / uGrid.x, v)).rgb;
      else if (vN.x > 0.5 && bit(vFaces,2.0) > 0.5)  col = texture2D(uSide, vec2(1.0 - (vCell.z + p.z) / uGrid.z, v)).rgb;
      else if (vN.x < -0.5 && bit(vFaces,3.0) > 0.5) col = texture2D(uSide, vec2((vCell.z + p.z) / uGrid.z, v)).rgb;
      else if (vN.y > 0.5 && bit(vFaces,4.0) > 0.5)  col = vec3(0.62, 0.62, 0.6) + n;
      float d = max(dot(normalize(vNW), uLight), 0.0);
      vec3 c = col * (0.55 + 0.6 * d);
      float f = smoothstep(uFogNear, uFogFar, vDepth);
      gl_FragColor = vec4(mix(c, uFog, f), 1.0);
    }`,
});
const boxGeo = new THREE.BoxGeometry(1, 1, 1);

let sim, blocks;
const M = new THREE.Matrix4(), Pv = new THREE.Vector3(), Qv = new THREE.Quaternion(), Sv = new THREE.Vector3();
function writeBlock(i) {
  const s = sim.scale[i];
  Pv.fromArray(sim.pos, i * 3); Qv.fromArray(sim.quat, i * 4);
  Sv.set(GEO.cw * s, GEO.ch * s, GEO.cd * s);
  M.compose(Pv, Qv, Sv); blocks.setMatrixAt(i, M);
}
function buildWorld() {
  sim = new Sim(GEO, () => true);
  if (!blocks) {
    const g = boxGeo.clone();
    const cell = new Float32Array(sim.N * 3);
    for (let i = 0; i < sim.N; i++) cell.set(sim.coords(i).map((v, k) => v), i * 3);
    // coords는 [ix,iy,iz] → 셰이더는 (x,y,z) 순서
    g.setAttribute('aCell', new THREE.InstancedBufferAttribute(cell, 3));
    g.setAttribute('aFaces', new THREE.InstancedBufferAttribute(sim.faces, 1));
    blocks = new THREE.InstancedMesh(g, blockMat, sim.N);
    blocks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    blocks.frustumCulled = false;
    scene.add(blocks);
    const sh = new THREE.Mesh(new THREE.PlaneGeometry(sim.W * 2.2, sim.D * 2.6), new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }));
    sh.rotation.x = -Math.PI / 2; sh.position.y = 0.05; scene.add(sh);
  }
  for (let i = 0; i < sim.N; i++) writeBlock(i);
  blocks.instanceMatrix.needsUpdate = true;
}
buildWorld();

// ── 먼지 · 파편 파티클 ─────────────────────────────
const PN = 1400;
const pGeo = new THREE.BufferGeometry();
const pPos = new Float32Array(PN * 3), pSize = new Float32Array(PN), pAlpha = new Float32Array(PN), pCol = new Float32Array(PN * 3);
pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3).setUsage(THREE.DynamicDrawUsage));
pGeo.setAttribute('aSize', new THREE.BufferAttribute(pSize, 1).setUsage(THREE.DynamicDrawUsage));
pGeo.setAttribute('aAlpha', new THREE.BufferAttribute(pAlpha, 1).setUsage(THREE.DynamicDrawUsage));
pGeo.setAttribute('aColor', new THREE.BufferAttribute(pCol, 3));
const pMat = new THREE.ShaderMaterial({
  uniforms: { uScale: { value: 500 } }, transparent: true, depthWrite: false,
  vertexShader: `attribute float aSize; attribute float aAlpha; attribute vec3 aColor; uniform float uScale;
    varying float vA; varying vec3 vC;
    void main(){ vA = aAlpha; vC = aColor; vec4 mv = modelViewMatrix * vec4(position,1.0);
      gl_PointSize = aSize * uScale / max(-mv.z, 1.0); gl_Position = projectionMatrix * mv; }`,
  fragmentShader: `varying float vA; varying vec3 vC;
    void main(){ float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.15, d) * vA; if (a < 0.01) discard; gl_FragColor = vec4(vC, a); }`,
});
const points = new THREE.Points(pGeo, pMat); points.frustumCulled = false; scene.add(points);
const P = Array.from({ length: PN }, () => ({ life: 0, max: 1, vx: 0, vy: 0, vz: 0, s0: 1, grow: 0, a0: 1, grav: 0, drag: 1 }));
let pNext = 0;
function emit(x, y, z, o) {
  const i = pNext; pNext = (pNext + 1) % PN; const p = P[i];
  p.life = p.max = o.life; p.vx = o.vx; p.vy = o.vy; p.vz = o.vz; p.s0 = o.size; p.grow = o.grow || 0;
  p.a0 = o.alpha ?? 0.8; p.grav = o.grav || 0; p.drag = o.drag ?? 0.98;
  pPos[i * 3] = x; pPos[i * 3 + 1] = y; pPos[i * 3 + 2] = z;
  pCol[i * 3] = o.c[0]; pCol[i * 3 + 1] = o.c[1]; pCol[i * 3 + 2] = o.c[2];
}
const R = (a, b) => a + Math.random() * (b - a);
const DUST = [0.74, 0.68, 0.6], DARK = [0.35, 0.33, 0.31];
function dust(x, y, z, n, spread, size) {
  for (let k = 0; k < n; k++) {
    const g = R(-0.06, 0.06);
    emit(x + R(-spread, spread), y + R(-spread * 0.5, spread * 0.5), z + R(-spread, spread), {
      life: R(2.2, 4.5), vx: R(-5, 5), vy: R(0, 4), vz: R(-5, 5), size: R(size * 0.6, size), grow: size * 0.9,
      alpha: R(0.45, 0.75), drag: 0.96, c: [DUST[0] + g, DUST[1] + g, DUST[2] + g],
    });
  }
}
function chips(x, y, z, n, speed, col = DARK) {
  for (let k = 0; k < n; k++)
    emit(x, y, z, { life: R(1.2, 2.4), vx: R(-speed, speed), vy: R(0, speed * 1.2), vz: R(-speed, speed), size: R(0.5, 1.4), alpha: 1, grav: 9.8, drag: 0.995, c: col });
}
function updateParticles(dt) {
  for (let i = 0; i < PN; i++) {
    const p = P[i];
    if (p.life <= 0) { pAlpha[i] = 0; continue; }
    p.life -= dt;
    p.vy -= p.grav * dt; p.vx *= p.drag; p.vy *= p.drag; p.vz *= p.drag;
    pPos[i * 3] += p.vx * dt; pPos[i * 3 + 1] += p.vy * dt; pPos[i * 3 + 2] += p.vz * dt;
    if (pPos[i * 3 + 1] < 0.2) { pPos[i * 3 + 1] = 0.2; p.vy *= -0.2; }
    const k = Math.max(p.life / p.max, 0);
    pSize[i] = p.s0 + p.grow * (1 - k);
    pAlpha[i] = p.a0 * Math.min(1, k * 1.6);
  }
  pGeo.attributes.position.needsUpdate = pGeo.attributes.aSize.needsUpdate = pGeo.attributes.aAlpha.needsUpdate = true;
  pGeo.attributes.aColor.needsUpdate = true;
}

// ── 소리 (WebAudio 합성) ──────────────────────────
let actx = null, noiseBuf = null; const lastSnd = {};
function initAudio() {
  try {
    actx = new (window.AudioContext || window.webkitAudioContext)();
    noiseBuf = actx.createBuffer(1, actx.sampleRate * 2, actx.sampleRate);
    const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    actx.resume?.();
  } catch (e) { actx = null; }
}
function sound(type, vol = 1) {
  if (!actx || muted) return;
  const now = actx.currentTime;
  const gap = { land: 0.09, crush: 0.25, thud: 0.1 }[type] || 0.03;
  if (lastSnd[type] && now - lastSnd[type] < gap) return; lastSnd[type] = now;
  const cfg = {
    impact: { f: 900, d: 0.9, low: 70, v: 0.9 }, land: { f: 500, d: 0.35, low: 0, v: 0.25 },
    crush: { f: 300, d: 1.6, low: 40, v: 0.6 }, fail: { f: 260, d: 3.0, low: 35, v: 1.0 },
    crack: { f: 1800, d: 0.5, low: 0, v: 0.5 }, thud: { f: 400, d: 0.3, low: 60, v: 0.4 },
    splat: { f: 2500, d: 0.25, low: 0, v: 0.6 }, throw: { f: 1200, d: 0.25, low: 0, v: 0.15 },
  }[type];
  if (!cfg) return;
  const v = cfg.v * vol;
  const src = actx.createBufferSource(); src.buffer = noiseBuf;
  const fl = actx.createBiquadFilter(); fl.type = type === 'throw' ? 'bandpass' : 'lowpass';
  fl.frequency.setValueAtTime(cfg.f, now); fl.frequency.exponentialRampToValueAtTime(Math.max(60, cfg.f * 0.2), now + cfg.d);
  const g = actx.createGain(); g.gain.setValueAtTime(v, now); g.gain.exponentialRampToValueAtTime(0.001, now + cfg.d);
  src.connect(fl).connect(g).connect(actx.destination); src.start(now, Math.random()); src.stop(now + cfg.d + 0.05);
  if (cfg.low) {
    const o = actx.createOscillator(); o.frequency.setValueAtTime(cfg.low * 1.6, now); o.frequency.exponentialRampToValueAtTime(cfg.low * 0.6, now + cfg.d);
    const og = actx.createGain(); og.gain.setValueAtTime(v * 0.9, now); og.gain.exponentialRampToValueAtTime(0.001, now + cfg.d);
    o.connect(og).connect(actx.destination); o.start(now); o.stop(now + cfg.d + 0.05);
  }
}
let muted = false;

// ── 투척물 스프라이트 · 조준선 ─────────────────────
const sprites = new Map();
const aimPts = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: 0xffffff, size: 1.1, transparent: true, opacity: 0.9, depthTest: false }));
aimPts.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(120 * 3), 3));
aimPts.renderOrder = 10; aimPts.visible = false; scene.add(aimPts);
const ringTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d');
  g.strokeStyle = '#ff3b2f'; g.lineWidth = 10; g.beginPath(); g.arc(64, 64, 50, 0, 7); g.stroke();
  g.lineWidth = 6; g.beginPath(); g.moveTo(64, 30); g.lineTo(64, 98); g.moveTo(30, 64); g.lineTo(98, 64); g.stroke();
  return new THREE.CanvasTexture(c);
})();
const marker = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTex, depthTest: false, transparent: true }));
marker.scale.set(7, 7, 1); marker.renderOrder = 11; marker.visible = false; scene.add(marker);

// ── 게임 상태 ───────────────────────────────────
let theta = 0, omega = 0, shake = 0;
let counts = ITEMS.map((it) => it.count);
let selected = 1;
let state = 'title';
let pendingGain = [];
let endTimer = 0;

const itemsEl = $('#items');
ITEMS.forEach((it, i) => {
  const b = document.createElement('button');
  b.className = 'item'; b.dataset.i = i;
  b.innerHTML = `<img src="assets/item${i}.webp" alt=""><span class="cnt"></span><span class="nm">${it.name}</span>`;
  b.onclick = () => { if (counts[i] > 0) { selected = i; refreshItems(); showTip(`${it.name} · ${it.desc}`); } };
  itemsEl.appendChild(b);
});
function refreshItems() {
  [...itemsEl.children].forEach((b, i) => {
    b.querySelector('.cnt').textContent = counts[i];
    b.classList.toggle('sel', i === selected);
    b.classList.toggle('empty', counts[i] === 0);
  });
}
refreshItems();
let tipT;
function showTip(t) { const el = $('#tip'); el.textContent = t; el.classList.add('on'); clearTimeout(tipT); tipT = setTimeout(() => el.classList.remove('on'), 1600); }

function playerPos() { return new THREE.Vector3(Math.sin(theta) * R_PLAYER, 0, Math.cos(theta) * R_PLAYER); }

// 조준 계산: 위로 끈 정도 t(0~1) → 목표 높이, 좌우로 끈 정도 → 방향
function aimSolution(t, yaw) {
  const it = ITEMS[selected];
  const P0 = playerPos();
  const f = P0.clone().multiplyScalar(-1 / P0.length());
  const dir = f.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), -yaw);
  const L = P0.clone().addScaledVector(f, 1.5); L.y = it.r + 1.6;
  // 건물 외곽 상자와의 수평 거리
  const hw = sim.W / 2, hd = sim.D / 2;
  let tmin = -Infinity, tmax = Infinity;
  for (const [o, d, h] of [[L.x, dir.x, hw], [L.z, dir.z, hd]]) {
    if (Math.abs(d) < 1e-6) { if (Math.abs(o) > h) { tmin = Infinity; } continue; }
    let a = (-h - o) / d, b = (h - o) / d; if (a > b) [a, b] = [b, a];
    tmin = Math.max(tmin, a); tmax = Math.min(tmax, b);
  }
  const dist = tmin <= tmax && tmin > 0 ? tmin : L.length() - hd;
  const hTarget = 2 + t * (sim.H + 6);
  // 빠른 직구: 고정 속도로 낮은 궤적(저각 해)을 사용
  const g = 9.8, h = hTarget - L.y;
  let v = THROW_SPEED, a;
  const disc = v ** 4 - g * (g * dist * dist + 2 * h * v * v);
  if (disc >= 0) a = Math.atan((v * v - Math.sqrt(disc)) / (g * dist));
  else { a = Math.PI / 4; v = Math.sqrt((g * dist * dist) / (2 * Math.cos(a) ** 2 * Math.max(dist - h, 0.5))); }
  const vel = dir.multiplyScalar(v * Math.cos(a)); vel.y = v * Math.sin(a);
  return { L, vel, hTarget };
}
function previewAim(sol) {
  const arr = aimPts.geometry.attributes.position.array;
  const r = ITEMS[selected].r;
  const p = sol.L.toArray(), v = sol.vel.toArray();
  const h = 1 / 120; let n = 0, hit = null;
  for (let s = 0; s < 1200 && n < 120; s++) {
    v[1] -= 9.8 * h; p[0] += v[0] * h; p[1] += v[1] * h; p[2] += v[2] * h;
    if (s % 6 === 0) { arr[n * 3] = p[0]; arr[n * 3 + 1] = p[1]; arr[n * 3 + 2] = p[2]; n++; }
    if (p[1] - r < 0) { hit = p; break; }
    if (sim.touching(p, r)) { hit = p; break; }
  }
  aimPts.geometry.setDrawRange(0, n); aimPts.geometry.attributes.position.needsUpdate = true;
  aimPts.visible = true;
  if (hit) { marker.position.set(hit[0], hit[1], hit[2]); marker.visible = true; } else marker.visible = false;
}

// ── 입력: 조준 · 던지기 ───────────────────────────
let aiming = null, poseT = 0;
// 포즈 이미지 미리 불러오기 (던질 때 바로 바뀌도록)
const preload = ['assets/thrower_idle.webp', 'assets/thrower_throw.webp'].map((u) => { const im = new Image(); im.src = u; im.decode?.().catch(() => {}); return im; });
canvas.addEventListener('pointerdown', (e) => {
  if (state !== 'play' || counts[selected] <= 0) { if (state === 'play') showTip('남은 물건을 선택하세요'); return; }
  aiming = { x: e.clientX, y: e.clientY, t: 0, yaw: 0, id: e.pointerId };
  canvas.setPointerCapture?.(e.pointerId);
  $('#thrower').classList.add('aim');
  $('#hint').classList.add('off');
});
canvas.addEventListener('pointermove', (e) => {
  if (!aiming || e.pointerId !== aiming.id) return;
  aiming.t = THREE.MathUtils.clamp((aiming.y - e.clientY) / (innerHeight * 0.42), 0, 1);
  aiming.yaw = THREE.MathUtils.clamp(((e.clientX - aiming.x) / innerWidth) * 1.1, -0.55, 0.55);
});
function endAim(e) {
  if (!aiming || e.pointerId !== aiming.id) return;
  const a = aiming; aiming = null;
  $('#thrower').classList.remove('aim');
  aimPts.visible = false; marker.visible = false; $('#floor').classList.remove('on');
  if (a.t < 0.03 || state !== 'play' || counts[selected] <= 0) return;
  const sol = aimSolution(a.t, a.yaw);
  const pr = sim.throwItem(ITEMS[selected], sol.L.toArray(), sol.vel.toArray());
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tItems[selected] }));
  const s = ITEMS[selected].r * 2.6; sp.scale.set(s, s, 1); scene.add(sp); sprites.set(pr, sp);
  counts[selected]--;
  pendingGain.push({ t: 4.0, before: sim.destroyed() });
  if (counts[selected] === 0) { const nx = counts.findIndex((c) => c > 0); if (nx >= 0) selected = nx; }
  refreshItems();
  sound('throw');
  const th = $('#thrower'); clearTimeout(poseT);
  th.src = 'assets/thrower_throw.webp'; th.classList.add('throw');
  poseT = setTimeout(() => { th.src = 'assets/thrower_idle.webp'; th.classList.remove('throw'); }, 900);
}
canvas.addEventListener('pointerup', endAim);
canvas.addEventListener('pointercancel', endAim);

// 이동: 휴대폰 기울기 / 버튼 / 키보드
let tilt = 0, tiltBase = null, tiltOn = false, btnDir = 0;
const keys = {};
addEventListener('keydown', (e) => (keys[e.key] = true));
addEventListener('keyup', (e) => (keys[e.key] = false));
for (const [id, d] of [['#left', -1], ['#right', 1]]) {
  const b = $(id);
  b.addEventListener('pointerdown', (e) => { e.preventDefault(); btnDir = d; });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, () => (btnDir = 0));
}
function onOrient(e) {
  if (e.gamma == null) return;
  const ang = (screen.orientation && screen.orientation.angle) ?? window.orientation ?? 0;
  const v = ang === 90 ? e.beta : ang === -90 || ang === 270 ? -e.beta : e.gamma;
  if (tiltBase == null) tiltBase = v;
  tilt = v - tiltBase;
  if (!tiltOn) { tiltOn = true; $('#mode').textContent = '📱 휴대폰을 좌우로 기울여 이동'; }
}
async function enableTilt() {
  try {
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      const r = await DeviceOrientationEvent.requestPermission();
      if (r !== 'granted') return;
    }
    addEventListener('deviceorientation', onOrient);
  } catch (e) { /* 지원 안 함 → 버튼으로 이동 */ }
}
$('#recal').onclick = () => { tiltBase = null; showTip('지금 자세를 기준으로 맞췄어요'); };

// ── 화면 전환 ───────────────────────────────────
$('#start').disabled = false; $('#start').textContent = '시작하기';
$('#start').onclick = async () => {
  initAudio();
  await enableTilt();
  $('#title').classList.add('gone');
  state = 'play';
};
$('#restart').onclick = restart;
$('#again').onclick = restart;
$('#finish').onclick = () => state === 'play' && showResult();
$('#mute').onclick = () => { muted = !muted; $('#mute').textContent = muted ? '🔇' : '🔊'; };
function restart() {
  aiming = null;
  for (const sp of sprites.values()) scene.remove(sp); sprites.clear();
  for (const p of P) p.life = 0;
  buildWorld();
  counts = ITEMS.map((it) => it.count); selected = 1; refreshItems();
  pendingGain = []; endTimer = 0; theta = 0;
  $('#result').classList.remove('on');
  state = 'play';
}
function showResult() {
  state = 'result';
  const d = sim.destroyed() * 100;
  const left = counts.reduce((a, b) => a + b, 0);
  const stars = d >= 90 ? 3 : d >= 60 ? 2 : d >= 30 ? 1 : 0;
  $('#rpct').textContent = d.toFixed(0) + '%';
  $('#rstar').textContent = '★'.repeat(stars) + '☆'.repeat(3 - stars);
  $('#rmsg').textContent = d >= 90 ? '완전 박살! 오늘은 칼퇴각입니다.' : d >= 60 ? '속이 뻥 뚫렸다!' : d >= 30 ? '조금 후련해졌다… 한 번 더?' : '아직 스트레스가 남아있다. 다시!';
  $('#rsub').textContent = left ? `물건 ${left}개를 남기고 끝냈어요` : '저층을 노리면 위층이 통째로 내려앉아요';
  $('#result').classList.add('on');
}
function popup(text) {
  const el = document.createElement('div'); el.className = 'pop'; el.textContent = text;
  $('#ui').appendChild(el); setTimeout(() => el.remove(), 1600);
}

// ── 메인 루프 ───────────────────────────────────
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.fov = w < h ? 72 : 55; camera.updateProjectionMatrix();
  pMat.uniforms.uScale.value = (h * renderer.getPixelRatio() * 0.5) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
}
addEventListener('resize', resize); resize();

const thrower = $('#thrower');
let last = performance.now();
function frame(now) {
  const dt = Math.min((now - last) / 1000, 1 / 20); last = now;
  // 이동
  let want = 0;
  if (state === 'play') {
    if (tiltOn) { const a = Math.abs(tilt); if (a > 4) want = Math.sign(tilt) * Math.min(1, (a - 4) / 22); }
    if (btnDir) want = btnDir;
    if (keys.ArrowLeft || keys.a) want = -1;
    if (keys.ArrowRight || keys.d) want = 1;
  }
  omega += (want * 0.75 - omega) * Math.min(1, dt * 6);
  theta += omega * dt;
  thrower.style.transform = `translateX(-50%) rotate(${omega * 9}deg) translateY(${Math.abs(Math.sin(now / 90)) * Math.abs(omega) * -10}px) scale(var(--ps, 1))`;

  // 물리
  sim.step(dt);
  for (const i of sim.takeDirty()) writeBlock(i);
  blocks.instanceMatrix.needsUpdate = true;
  for (const e of sim.events) {
    if (e.t === 'impact') { dust(e.x, e.y, e.z, 16 + e.n, 3, 12); chips(e.x, e.y, e.z, 18, 9); shake = Math.max(shake, 0.6); sound('impact'); }
    else if (e.t === 'splat') { chips(e.x, e.y, e.z, 45, 8, [0.85, 0.12, 0.15]); chips(e.x, e.y, e.z, 20, 6, [0.2, 0.55, 0.2]); sound('splat'); popup('퍽!'); }
    else if (e.t === 'land') { if (Math.random() < 0.6) dust(e.x, e.y + 1, e.z, 2, 2, 14); sound('land', Math.min(1, e.s / 20)); }
    else if (e.t === 'thud') { dust(e.x, e.y, e.z, 5, 1, 6); sound('thud'); }
    else if (e.t === 'crack') { shake = Math.max(shake, 1.0); sound('crack'); }
    else if (e.t === 'fail') { dust(e.x, e.y, e.z, 40, sim.W * 0.4, 22); shake = Math.max(shake, 1.6); sound('fail'); popup('붕괴!!'); }
    else if (e.t === 'crush') { dust(e.x + R(-15, 15), Math.max(4, e.y), e.z + R(-10, 10), 6, 8, 20); shake = Math.max(shake, 0.9); sound('crush'); }
  }
  sim.events.length = 0;
  for (const [pr, sp] of sprites) {
    if (!sim.projectiles.includes(pr) || pr.hidden) { scene.remove(sp); sprites.delete(pr); continue; }
    sp.position.fromArray(pr.p); sp.material.rotation = -pr.rot;
  }
  updateParticles(dt);

  // 진행률 · 결과
  const d = sim.destroyed();
  $('#bar i').style.width = (d * 100).toFixed(1) + '%';
  $('#pct').textContent = (d * 100).toFixed(0) + '%';
  for (const g of pendingGain) { g.t -= dt; if (g.t <= 0) { const gain = (d - g.before) * 100; popup(gain >= 0.5 ? `+${gain.toFixed(1)}%` : '꿈쩍도 안 함…'); } }
  pendingGain = pendingGain.filter((g) => g.t > 0);
  if (state === 'play' && counts.every((c) => c === 0)) {
    if (!sim.busy() && !pendingGain.length) { endTimer += dt; if (endTimer > 1.5) showResult(); } else endTimer = 0;
  }

  // 조준 미리보기
  if (aiming && state === 'play') {
    const sol = aimSolution(aiming.t, aiming.yaw);
    previewAim(sol);
    const fl = $('#floor'); fl.classList.add('on');
    fl.textContent = `${Math.max(1, Math.min(GEO.ny, Math.round(sol.hTarget / GEO.ch)))}층 조준`;
  }

  // 카메라
  const pp = playerPos(); const out = pp.clone().normalize();
  camera.position.copy(pp).addScaledVector(out, 8); camera.position.y = 3.6;
  if (shake > 0.01) { camera.position.x += R(-1, 1) * shake; camera.position.y += R(-1, 1) * shake; shake *= Math.pow(0.04, dt); }
  camera.lookAt(0, 46, 0);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
