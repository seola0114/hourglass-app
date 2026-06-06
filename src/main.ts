import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { HourglassSim, bulgeRadius, HG_H } from './simulation';

// ── Config ──
const STEPS = 3;
const SAND_HEX = [
  0xffffff, 0xfffdf4, 0xfff8e4, 0xf6fbff, 0xfff1c8, 0xf9e7b8, 0xffffff, 0xfff6d8,
];
const SAND_COL = SAND_HEX.map((h) => new THREE.Color(h));
let P_SIZE = 0.007;
let PARTICLES_PER_CELL = 10; // 셀당 입자 N개 → 미세한 가루처럼 연속적인 흐름

// ── Simulation core (Three.js 무관) ──
const sim = new HourglassSim({
  gW: 65,
  gH: 130,
  neckHW: 2,
  duration: 60,
  sandFill: 1.0,
  slideMax: 3,
  colorCount: SAND_COL.length,
});
const n = sim.gW * sim.gH;

// ── State ──
type State = 'IDLE' | 'RUNNING' | 'PAUSE' | 'COMPLETED';
let state: State = 'IDLE';
let W: number, H: number;
let t0 = 0,
  tDone = 0,
  fc = 0,
  tPause = 0;
let prevFlip = false,
  hasOrient = false;
let flipAnim = -1;
const flipDur = 0.55;
let particlePos: Float32Array;
// 90° 단위 회전 — 좌/우 버튼 클릭마다 누적 (unbounded). 좌+1, 우-1.
let accumTilt = 0; // quarter turns (정수)
let visualTiltZ = 0; // 화면 내 z축 회전 (라디안, target = accumTilt * π/2)

// ── UI refs ──
const statusEl = document.getElementById('status')!;
const timerEl = document.getElementById('timer')!;
const hintEl = document.getElementById('hint')!;

// ── Three.js Setup ──
W = window.visualViewport?.width || window.innerWidth;
H = window.visualViewport?.height || window.innerHeight;
const dpr = Math.min(window.devicePixelRatio || 1, 2);

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x17486e, 0.018);

function makeSceneBackground() {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 1536;
  const ctx = c.getContext('2d')!;
  const sky = ctx.createLinearGradient(0, 0, 0, c.height);
  sky.addColorStop(0, '#153d68');
  sky.addColorStop(0.28, '#25698f');
  sky.addColorStop(0.55, '#5a92aa');
  sky.addColorStop(0.78, '#928dac');
  sky.addColorStop(1, '#d59aad');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, c.width, c.height);

  const clouds: Array<[number, number, number, string]> = [
    [250, 1280, 360, 'rgba(255,170,206,0.30)'],
    [790, 1350, 430, 'rgba(255,196,210,0.24)'],
    [520, 1460, 520, 'rgba(255,222,194,0.18)'],
    [520, 760, 500, 'rgba(84,227,255,0.12)'],
  ];
  for (const cloud of clouds) {
    const g = ctx.createRadialGradient(cloud[0], cloud[1], 0, cloud[0], cloud[1], cloud[2]);
    g.addColorStop(0, cloud[3]);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, c.width, c.height);
  }

  const vignette = ctx.createRadialGradient(512, 720, 120, 512, 720, 920);
  vignette.addColorStop(0, 'rgba(255,255,255,0)');
  vignette.addColorStop(0.68, 'rgba(10,35,70,0.04)');
  vignette.addColorStop(1, 'rgba(8,18,42,0.32)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, c.width, c.height);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
scene.background = makeSceneBackground();

const camera = new THREE.PerspectiveCamera(24, W / H, 0.1, 100);
camera.position.set(0.15, 0.15, 13);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setSize(W, H);
renderer.setPixelRatio(dpr);
renderer.setClearColor(0x000000, 0);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.88;
document.body.appendChild(renderer.domElement);

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloomPass = new UnrealBloomPass(new THREE.Vector2(W * dpr, H * dpr), 0.22, 0.55, 0.86);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());

// ── Lights ──
scene.add(new THREE.AmbientLight(0xb8c8e8, 0.9));
const dirLight = new THREE.DirectionalLight(0xfff0c8, 1.4);
dirLight.position.set(3, 4, 5);
scene.add(dirLight);
const rimLight = new THREE.DirectionalLight(0x88a8ff, 1.1);
rimLight.position.set(-3, -1, -3);
scene.add(rimLight);
const warmLight = new THREE.PointLight(0xffd890, 1.4, 10);
warmLight.position.set(0, -1, 3);
scene.add(warmLight);
const pileLight = new THREE.PointLight(0xffc45c, 0.75, 3.2);
pileLight.position.set(0, -1.25, 1.2);
scene.add(pileLight);
const topLight = new THREE.PointLight(0xa0c0ff, 0.7, 10);
topLight.position.set(0, 3, 2);
scene.add(topLight);
const aquaLight = new THREE.PointLight(0x63f2ff, 1.1, 6);
aquaLight.position.set(0, 0.75, 1.8);
scene.add(aquaLight);
// 골든 글로우 — 모래시계 내부를 따뜻하게 발광시키는 중심 라이트
const innerGlow = new THREE.PointLight(0xffe0a0, 1.2, 3);
innerGlow.position.set(0, -0.6, 0);
scene.add(innerGlow);

// ── Hourglass Group ──
const hgGroup = new THREE.Group();
hgGroup.rotation.y = -0.08;
scene.add(hgGroup);

// ── Glass body (profile from simulation module) ──
function glassProfile() {
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= 220; i++) {
    const t = i / 220;
    const d = Math.abs(t - 0.5) * 2;
    const r = bulgeRadius(d);
    pts.push(new THREE.Vector2(r, (t - 0.5) * HG_H));
  }
  return pts;
}

const glassGeo = new THREE.LatheGeometry(glassProfile(), 128);
const glassMat = new THREE.MeshPhysicalMaterial({
  color: 0xdffcff,
  transparent: true,
  opacity: 0.22,
  roughness: 0.05,
  metalness: 0.0,
  transmission: 0.92,
  thickness: 0.5,
  attenuationColor: new THREE.Color(0xc6f3ff),
  attenuationDistance: 4.0,
  clearcoat: 0.55,
  clearcoatRoughness: 0.12,
  iridescence: 0.0,
  ior: 1.45,
  reflectivity: 0.55,
  envMapIntensity: 0.7,
  specularIntensity: 0.55,
  specularColor: new THREE.Color(0xeaf6ff),
  side: THREE.DoubleSide,
  depthWrite: false,
});
const glassMesh = new THREE.Mesh(glassGeo, glassMat);
glassMesh.renderOrder = 3;
hgGroup.add(glassMesh);

// Soft aqua glow inside the upper glass.
const upperGlow = new THREE.Mesh(
  new THREE.SphereGeometry(0.72, 40, 24),
  new THREE.MeshBasicMaterial({
    color: 0x64f6ff,
    transparent: true,
    opacity: 0.006,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  }),
);
upperGlow.position.y = 0.82;
upperGlow.scale.set(1.18, 0.72, 1.18);
hgGroup.add(upperGlow);

// Frame: iridescent warm-gold metal (caps, beads, finial)
const frameMat = new THREE.MeshPhysicalMaterial({
  color: 0xe8fbff,
  transparent: true,
  opacity: 0.28,
  metalness: 0.0,
  roughness: 0.02,
  transmission: 0.84,
  thickness: 0.5,
  attenuationColor: new THREE.Color(0xc8fbff),
  attenuationDistance: 2.4,
  clearcoat: 1.0,
  clearcoatRoughness: 0.02,
  iridescence: 1.0,
  iridescenceIOR: 1.45,
  iridescenceThicknessRange: [160, 760],
  emissive: 0x79eaff,
  emissiveIntensity: 0.05,
  envMapIntensity: 1.4,
  reflectivity: 0.85,
  depthWrite: false,
});
const FRAME_R = 0.82 + 0.18;
const CAP_THK = 0.16;

// Top & bottom plates
for (const ySign of [-1, 1]) {
  const y = ySign * (HG_H / 2 + CAP_THK / 2 + 0.02);
  const plate = new THREE.Mesh(
    new THREE.CylinderGeometry(FRAME_R, FRAME_R * 0.95, CAP_THK, 96),
    frameMat,
  );
  plate.position.y = y;
  hgGroup.add(plate);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(FRAME_R, 0.035, 18, 112), frameMat);
  rim.position.y = y + ySign * (CAP_THK / 2 - 0.01);
  rim.rotation.x = Math.PI / 2;
  hgGroup.add(rim);
}

// Top finial: small transparent bead
const finialY = HG_H / 2 + CAP_THK + 0.08;
const finial = new THREE.Mesh(new THREE.SphereGeometry(0.045, 32, 24), frameMat);
finial.position.y = finialY + 0.04;
hgGroup.add(finial);

const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.06, 18), frameMat);
stem.position.y = finialY;
hgGroup.add(stem);

// ── Crescent moon emblem inside bottom bulb ──
function makeMoonTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d')!;
  const grad = ctx.createRadialGradient(128, 128, 10, 128, 128, 128);
  grad.addColorStop(0, 'rgba(255,235,180,0.85)');
  grad.addColorStop(0.35, 'rgba(255,210,140,0.45)');
  grad.addColorStop(0.7, 'rgba(255,190,120,0.15)');
  grad.addColorStop(1, 'rgba(255,180,100,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 256, 256);
  ctx.save();
  ctx.translate(128, 128);
  ctx.rotate(-Math.PI * 0.15);
  const moonGrad = ctx.createRadialGradient(0, 0, 10, 0, 0, 56);
  moonGrad.addColorStop(0, 'rgba(255,250,220,1)');
  moonGrad.addColorStop(0.7, 'rgba(255,235,180,0.95)');
  moonGrad.addColorStop(1, 'rgba(255,210,140,0.8)');
  ctx.fillStyle = moonGrad;
  ctx.beginPath();
  ctx.arc(0, 0, 56, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath();
  ctx.arc(22, -8, 52, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const moonMat = new THREE.SpriteMaterial({
  map: makeMoonTexture(),
  transparent: true,
  opacity: 0.92,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});
const moonSprite = new THREE.Sprite(moonMat);
moonSprite.scale.set(0.6, 0.6, 1);
moonSprite.position.set(0, -0.85, 0);
hgGroup.add(moonSprite);

function makeDotTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 58);
  grad.addColorStop(0, 'rgba(255,255,235,1)');
  grad.addColorStop(0.32, 'rgba(118,246,255,0.42)');
  grad.addColorStop(1, 'rgba(118,246,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ── Background twinkling stars ──
const BG_STAR_N = 45;
const bgStarGeo = new THREE.BufferGeometry();
const bgStarPos = new Float32Array(BG_STAR_N * 3);
for (let i = 0; i < BG_STAR_N; i++) {
  const theta = Math.random() * Math.PI * 2;
  const phi = (Math.random() - 0.5) * Math.PI * 0.9;
  const radius = 3.2 + Math.random() * 2.8;
  bgStarPos[i * 3] = Math.cos(theta) * Math.cos(phi) * radius;
  bgStarPos[i * 3 + 1] = Math.sin(phi) * radius * 0.85;
  bgStarPos[i * 3 + 2] = Math.sin(theta) * Math.cos(phi) * radius - 1.5;
}
bgStarGeo.setAttribute('position', new THREE.BufferAttribute(bgStarPos, 3));
const bgStarMat = new THREE.PointsMaterial({
  map: makeDotTexture(),
  color: 0xfff8dc,
  size: 0.038,
  transparent: true,
  opacity: 0.48,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  sizeAttenuation: true,
});
const bgStars = new THREE.Points(bgStarGeo, bgStarMat);
scene.add(bgStars);

const DUST_N = 360;
const dustGeo = new THREE.BufferGeometry();
const dustPos = new Float32Array(DUST_N * 3);
for (let i = 0; i < DUST_N; i++) {
  const theta = Math.random() * Math.PI * 2;
  const radius = 0.45 + Math.random() * 2.1;
  dustPos[i * 3] = Math.cos(theta) * radius;
  dustPos[i * 3 + 1] = -2.0 + Math.random() * 4.2;
  dustPos[i * 3 + 2] = Math.sin(theta) * radius - 0.3;
}
dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
const dustMat = new THREE.PointsMaterial({
  map: makeDotTexture(),
  color: 0xcdfcff,
  size: 0.035,
  transparent: true,
  opacity: 0.38,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  sizeAttenuation: true,
});
const dustPoints = new THREE.Points(dustGeo, dustMat);
scene.add(dustPoints);

// ── Particle positions (격자 셀당 입자 위치) ──
// Spread는 입자 크기(P_SIZE)에 비례.
function buildParticlePositions() {
  particlePos = new Float32Array(n * PARTICLES_PER_CELL * 3);
  const yStep = HG_H / (sim.gH - 1);
  const sizeRatio = Math.min(P_SIZE / 0.005, 2.5);
  const spreadFactor = 0.5 + sizeRatio * 0.2;
  for (let r = 0; r < sim.gH; r++) {
    const yCenter = (0.5 - r / (sim.gH - 1)) * HG_H;
    const r3dRaw = sim.radius3D(r) * 0.82;
    const r3d = Math.max(0.01, r3dRaw - P_SIZE);
    const hw = sim.hw2(r) || 1;
    const xStep = r3dRaw / hw;
    const spreadX = xStep * 0.9 * spreadFactor;
    const spreadY = yStep * 0.9 * spreadFactor;
    for (let c = 0; c < sim.gW; c++) {
      const offset = c - sim.cCol;
      const xCenter = (offset / hw) * r3dRaw;
      for (let p = 0; p < PARTICLES_PER_CELL; p++) {
        const idx = ((r * sim.gW + c) * PARTICLES_PER_CELL + p) * 3;
        const h1 = Math.sin(r * 127.1 + c * 311.7 + p * 71.3) * 43758.5453;
        const h2 = Math.sin(r * 71.3 + c * 113.5 + p * 217.7) * 43758.5453;
        const h3 = Math.sin(r * 213.9 + c * 79.1 + p * 309.5) * 43758.5453;
        const jx = (h1 - Math.floor(h1) - 0.5) * spreadX;
        const jy = (h2 - Math.floor(h2) - 0.5) * spreadY;
        const zN = (h3 - Math.floor(h3)) * 2 - 1;
        let xPos = xCenter + jx;
        if (xPos > r3d) xPos = r3d;
        else if (xPos < -r3d) xPos = -r3d;
        const yPos = yCenter + jy;
        const zMax = Math.sqrt(Math.max(0, r3d * r3d - xPos * xPos));
        particlePos[idx] = xPos;
        particlePos[idx + 1] = yPos;
        particlePos[idx + 2] = zN * zMax;
      }
    }
  }
}
buildParticlePositions();

// ── Sand InstancedMesh ──
let sandGeo = new THREE.IcosahedronGeometry(P_SIZE, 0);
const sandMat = new THREE.MeshPhysicalMaterial({
  color: 0xffffff,
  roughness: 0.42,
  metalness: 0.0,
  sheen: 0.6,
  sheenColor: new THREE.Color(0xffffff),
  sheenRoughness: 0.45,
  emissive: 0xfff6d8,
  emissiveIntensity: 0.85,
  envMapIntensity: 0.6,
});

function makeSandMoundGeometry() {
  const pts: THREE.Vector2[] = [];
  pts.push(new THREE.Vector2(0, -1.64));
  pts.push(new THREE.Vector2(0.68, -1.64));
  for (let i = 0; i <= 48; i++) {
    const t = i / 48;
    const x = 0.68 * Math.pow(1 - t, 0.82);
    const y = -1.64 + 1.24 * Math.pow(t, 1.42);
    pts.push(new THREE.Vector2(x, y));
  }
  pts.push(new THREE.Vector2(0, -1.64));
  return new THREE.LatheGeometry(pts, 128);
}
const sandMound = new THREE.Mesh(
  makeSandMoundGeometry(),
  new THREE.MeshPhysicalMaterial({
    color: 0xfffdf4,
    transparent: true,
    opacity: 0.12,
    roughness: 0.72,
    metalness: 0.0,
    sheen: 1.0,
    sheenColor: new THREE.Color(0xffffff),
    emissive: 0xfff2d2,
    emissiveIntensity: 0.035,
    depthWrite: false,
  }),
);
sandMound.renderOrder = 1;
hgGroup.add(sandMound);
let sandMesh = new THREE.InstancedMesh(
  sandGeo,
  sandMat,
  (sim.maxSandCount + 500) * PARTICLES_PER_CELL,
);
sandMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
hgGroup.add(sandMesh);

const _mat4 = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scl = new THREE.Vector3(1, 1, 1);

function updateSandMesh() {
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (!sim.sand[i]) continue;
    const color = SAND_COL[sim.clr[i]];
    const base = i * PARTICLES_PER_CELL * 3;
    for (let p = 0; p < PARTICLES_PER_CELL; p++) {
      const pi = base + p * 3;
      _pos.set(particlePos[pi], particlePos[pi + 1], particlePos[pi + 2]);
      _mat4.compose(_pos, _quat, _scl);
      sandMesh.setMatrixAt(count, _mat4);
      sandMesh.setColorAt(count, color);
      count++;
    }
  }
  sandMesh.count = count;
  sandMesh.instanceMatrix.needsUpdate = true;
  if (sandMesh.instanceColor) sandMesh.instanceColor.needsUpdate = true;
}
updateSandMesh();

// ── Sparkle Points (완료 연출) ──
const SPARK_N = 30;
const sparkGeo2 = new THREE.BufferGeometry();
const sparkPos = new Float32Array(SPARK_N * 3);
const sparkSizes = new Float32Array(SPARK_N);
sparkGeo2.setAttribute('position', new THREE.BufferAttribute(sparkPos, 3));
sparkGeo2.setAttribute('size', new THREE.BufferAttribute(sparkSizes, 1));
const sparkMat2 = new THREE.PointsMaterial({
  color: 0xffc8e8,
  size: 0.09,
  transparent: true,
  opacity: 0,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  sizeAttenuation: true,
});
const sparkPoints = new THREE.Points(sparkGeo2, sparkMat2);
hgGroup.add(sparkPoints);

function initSparks() {
  for (let i = 0; i < SPARK_N; i++) {
    const r = sim.cRow + 3 + Math.random() * (sim.gH - sim.cRow - 6);
    const hw = sim.hw2(Math.round(r));
    const offset = (Math.random() - 0.5) * hw;
    const r3d = sim.radius3D(Math.round(r)) * 0.7;
    const x = (offset / (hw || 1)) * r3d;
    const zMax = Math.sqrt(Math.max(0, r3d * r3d - x * x));
    sparkPos[i * 3] = x;
    sparkPos[i * 3 + 1] = (0.5 - r / (sim.gH - 1)) * HG_H;
    sparkPos[i * 3 + 2] = (Math.random() * 2 - 1) * zMax;
    sparkSizes[i] = 0.04 + Math.random() * 0.08;
  }
  (sparkGeo2.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
}

// ── State Machine ──
// 탭/뒤집기는 항상 grid를 뒤집고 RUNNING으로 (재)시작.
function doFlip() {
  if (flipAnim >= 0) return;
  if (state === 'COMPLETED') {
    sim.fillBottom();
    sparkMat2.opacity = 0;
    warmLight.intensity = 1.4;
  }
  flipAnim = 0;
  state = 'RUNNING';
  t0 = Date.now();
  sim.resetFlowBudget();
  updateUI();
}

function updateUI() {
  statusEl.textContent =
    state === 'IDLE'
      ? '대기 중'
      : state === 'RUNNING'
        ? '진행 중'
        : state === 'PAUSE'
          ? '일시정지'
          : '완료';
  statusEl.className = state === 'COMPLETED' ? 'done' : '';
  hintEl.textContent =
    state === 'PAUSE'
      ? '세로로 다시 세우면 이어서 진행'
      : hasOrient
        ? '폰을 뒤집거나 화면을 탭하세요'
        : '화면을 탭하여 뒤집기';
}

// ── Settings Panel ──
const panel = document.getElementById('panel')!;
const panelToggle = document.getElementById('panel-toggle')!;
const panelBody = document.getElementById('panel-body')!;
panelBody.addEventListener('pointerdown', (e) => e.stopPropagation());
panelBody.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
panelToggle.addEventListener('pointerdown', (e) => e.stopPropagation());
panelToggle.addEventListener('click', (e) => {
  e.stopPropagation();
  panel.classList.toggle('open');
});

const rotLeftBtn = document.getElementById('b-rot-left')!;
const rotRightBtn = document.getElementById('b-rot-right')!;
function tiltMod4() {
  return ((accumTilt % 4) + 4) % 4;
}
function updateRotButtons() {
  const m = tiltMod4();
  rotLeftBtn.classList.toggle('active', m === 1 || m === 2);
  rotRightBtn.classList.toggle('active', m === 3 || m === 2);
}
[rotLeftBtn, rotRightBtn].forEach((btn) => {
  btn.addEventListener('pointerdown', (e) => e.stopPropagation());
});
rotLeftBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  accumTilt += 1;
  updateRotButtons();
});
rotRightBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  accumTilt -= 1;
  updateRotButtons();
});

const resetBtn = document.getElementById('b-reset')!;
resetBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
resetBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  // 회전·애니메이션·모래·타이머 모두 초기 상태로 되돌림
  accumTilt = 0;
  visualTiltZ = 0;
  flipAnim = -1;
  hgGroup.rotation.x = 0;
  state = 'IDLE';
  sim.resetFlowBudget();
  sim.fillBottom();
  sparkMat2.opacity = 0;
  warmLight.intensity = 1.4;
  updateRotButtons();
  updateUI();
});

function rebuildSandMesh() {
  hgGroup.remove(sandMesh);
  sandMesh.dispose();
  sandMesh = new THREE.InstancedMesh(sandGeo, sandMat, (sim.maxSandCount + 500) * PARTICLES_PER_CELL);
  sandMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  hgGroup.add(sandMesh);
}

function inputEl(id: string): HTMLInputElement {
  return document.getElementById(id) as HTMLInputElement;
}

inputEl('s-duration').addEventListener('input', (e) => {
  const v = +(e.target as HTMLInputElement).value;
  sim.setDuration(v);
  document.getElementById('v-duration')!.textContent = v + 's';
});
inputEl('s-sand').addEventListener('input', (e) => {
  const v = +(e.target as HTMLInputElement).value;
  sim.setSandFill(v / 100);
  document.getElementById('v-sand')!.textContent = v + '%';
  state = 'IDLE';
  sim.resetFlowBudget();
  sparkMat2.opacity = 0;
  warmLight.intensity = 1.4;
  updateUI();
});
inputEl('s-psize').addEventListener('input', (e) => {
  P_SIZE = +(e.target as HTMLInputElement).value / 10000;
  document.getElementById('v-psize')!.textContent = P_SIZE.toFixed(4);
  const oldGeo = sandGeo;
  sandGeo = new THREE.IcosahedronGeometry(P_SIZE, 0);
  sandMesh.geometry = sandGeo;
  oldGeo.dispose();
  buildParticlePositions();
});
inputEl('s-ppc').addEventListener('input', (e) => {
  PARTICLES_PER_CELL = +(e.target as HTMLInputElement).value;
  document.getElementById('v-ppc')!.textContent = String(PARTICLES_PER_CELL);
  buildParticlePositions();
  rebuildSandMesh();
});
inputEl('s-slide').addEventListener('input', (e) => {
  sim.slideMax = +(e.target as HTMLInputElement).value;
  document.getElementById('v-slide')!.textContent = String(sim.slideMax);
});

// ── Events ──
renderer.domElement.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  doFlip();
});
renderer.domElement.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
document.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });

function onOri(e: DeviceOrientationEvent) {
  if (e.beta == null) return;
  hasOrient = true;
  const f = e.beta < -30;
  if (f !== prevFlip) {
    prevFlip = f;
    // 폰을 거꾸로 뒤집은 순간에만 flip 트리거.
    if (f) doFlip();
  }
}
interface DeviceOrientationEventStatic {
  requestPermission?: () => Promise<PermissionState>;
}
if (window.DeviceOrientationEvent) {
  const doe = DeviceOrientationEvent as unknown as DeviceOrientationEventStatic;
  if (typeof doe.requestPermission === 'function') {
    renderer.domElement.addEventListener('pointerdown', function rp() {
      doe
        .requestPermission!()
        .then((r) => {
          if (r === 'granted') window.addEventListener('deviceorientation', onOri);
        })
        .catch(() => {});
      renderer.domElement.removeEventListener('pointerdown', rp);
    });
  } else {
    window.addEventListener('deviceorientation', onOri);
  }
}

function onResize() {
  W = window.visualViewport?.width || window.innerWidth;
  H = window.visualViewport?.height || window.innerHeight;
  camera.aspect = W / H;
  camera.updateProjectionMatrix();
  renderer.setSize(W, H);
  composer.setSize(W, H);
  bloomPass.resolution.set(W * dpr, H * dpr);
}
window.addEventListener('resize', onResize);
window.visualViewport?.addEventListener('resize', onResize);
try {
  const orientation = screen.orientation as ScreenOrientation & {
    lock?: (o: string) => Promise<void>;
  };
  orientation?.lock?.('portrait').catch(() => {});
} catch {
  /* 미지원 환경 무시 */
}

// ── Animation Loop ──
let prevTime = 0;
function animate(time: number) {
  const dt = Math.min((time - (prevTime || time)) / 1000, 0.1);
  prevTime = time;
  fc++;

  // Flip animation — 화면 평면 안에서 좌우로 도는 롤(Z축) 180°
  let flipRotZ = 0;
  if (flipAnim >= 0) {
    flipAnim += dt / flipDur;
    if (flipAnim >= 1) {
      flipAnim = -1;
      sim.flipGrid();
      flipRotZ = 0;
    } else {
      const t = flipAnim;
      const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      flipRotZ = ease * Math.PI;
    }
  }

  // 누적 회전 — accumTilt(quarter turn) * π/2 가 target.
  const manualTarget = (accumTilt * Math.PI) / 2;
  const tiltLerp = 1 - Math.exp(-dt * 5);
  visualTiltZ += (manualTarget - visualTiltZ) * tiltLerp;

  // 90°(가로) 자세 → 일시정지. 세로(0°/180°)일 때만 모래가 흐름.
  const m4 = ((accumTilt % 4) + 4) % 4;
  const horizontal = m4 === 1 || m4 === 3;
  if (state === 'RUNNING' && horizontal) {
    state = 'PAUSE';
    tPause = Date.now();
    updateUI();
  } else if (state === 'PAUSE' && !horizontal) {
    t0 += Date.now() - tPause; // 멈춘 시간만큼 시작 시각을 밀어 경과시간 보존
    state = 'RUNNING';
    updateUI();
  }

  // Sand simulation — 세로 자세에서만. 가로(일시정지)면 동결.
  if (flipAnim < 0 && !horizontal) {
    sim.addFlowBudget(dt);
    for (let i = 0; i < STEPS; i++) sim.step(visualTiltZ);
    if (state === 'RUNNING' && fc % 20 === 0 && sim.isDone()) {
      state = 'COMPLETED';
      tDone = Date.now();
      initSparks();
      sparkMat2.opacity = 0.9;
      try {
        navigator.vibrate?.(200);
      } catch {
        /* 미지원 무시 */
      }
      updateUI();
    }
  }

  // Completion 연출
  if (state === 'COMPLETED') {
    const elapsed = Date.now() - tDone;
    const pulse = Math.sin(elapsed * 0.006) * 0.4 + 0.5;
    sparkMat2.opacity = pulse;
    warmLight.intensity = 1.4 + pulse * 0.8;
  } else {
    sparkMat2.opacity = 0;
  }

  updateSandMesh();

  // Timer + 진행률 UI
  if (state === 'RUNNING' || state === 'PAUSE' || state === 'COMPLETED') {
    const nowRef = state === 'COMPLETED' ? tDone : state === 'PAUSE' ? tPause : Date.now();
    const e = (nowRef - t0) / 1000;
    timerEl.textContent = `${(e / 60) | 0}:${String((e % 60) | 0).padStart(2, '0')}`;
    const pct = state === 'COMPLETED' ? 100 : Math.min(100, Math.round((e / sim.duration) * 100));
    const label = state === 'COMPLETED' ? '완료' : state === 'PAUSE' ? '일시정지' : '진행 중';
    statusEl.textContent = label + ` · ${pct}%`;
  } else {
    timerEl.textContent = '';
  }

  // Twinkle background stars + pulse moon glow
  const tw = time * 0.001;
  bgStarMat.opacity = 0.7 + Math.sin(tw * 1.4) * 0.15;
  bgStarMat.size = 0.07 + Math.sin(tw * 0.7) * 0.012;
  moonMat.opacity = 0.78 + Math.sin(tw * 0.8) * 0.14;
  moonSprite.scale.setScalar(0.6 + Math.sin(tw * 0.6) * 0.025);
  upperGlow.material.opacity = 0.005;
  aquaLight.intensity = 0.35 + Math.sin(tw * 1.4) * 0.08;
  innerGlow.color.setHSL(0.12 + Math.sin(tw * 0.35) * 0.04, 0.85, 0.7);
  innerGlow.intensity = 0.8;
  dustPoints.rotation.y = 0;
  dustMat.opacity = 0.14;
  bloomPass.strength = 0.32;
  hgGroup.rotation.z = visualTiltZ + flipRotZ;
  camera.position.x = 0.15;
  camera.position.y = 0.15;
  camera.lookAt(0, 0, 0);

  composer.render();
  requestAnimationFrame(animate);
}

updateUI();
requestAnimationFrame(animate);
