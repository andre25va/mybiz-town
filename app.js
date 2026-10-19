import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/* ============================== config ============================== */
const DATA_URL = 'data.json';
const POLL_MS = 30000;

/* ============================== state =============================== */
let renderer, scene, camera, controls, raycaster;
const pointerNDC = new THREE.Vector2();
let staticGroup = null;
let townGroup = null;
let cars = [];            // { group, call, dist, speed }
let wavingFlags = [];
let lampMat = null;       // shared streetlight lamp material
let clickTargets = [];    // rebuilt with townGroup
let staticClickTargets = [];
let townData = null;
let downXY = null;
const clock = new THREE.Clock();

const BUILDING_SPOTS = [
  { x: -32, z: -28 },
  { x: 32, z: -28 },
  { x: -32, z: 28 },
];
const HOUSE_RING_R = 64;
const HOUSE_SLOTS = 8;
const CAR_LOOP = 40;
const CAR_COLORS = [0xc0392b, 0x2980b9, 0xf39c12, 0x8e44ad, 0x16a085, 0x607d8b];

/* ============================ utilities ============================= */
let seed = 42;
function rnd() {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
}[c]));

function fmtClock(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function fmtAgo(iso) {
  const ms = Date.now() - new Date(iso);
  if (isNaN(ms)) return '—';
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  return h + 'h ' + (m % 60) + 'm ago';
}

function fmtDur(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function makeLabel(lines, opts = {}) {
  const {
    fontSize = 44, fg = '#ffffff', bg = 'rgba(18,26,36,0.82)',
    pad = 22, worldH = 4.5,
  } = opts;
  const cv = document.createElement('canvas');
  let ctx = cv.getContext('2d');
  const font = `600 ${fontSize}px "Segoe UI", Arial, sans-serif`;
  ctx.font = font;
  const widths = lines.map((l) => ctx.measureText(l).width);
  cv.width = Math.ceil(Math.max(...widths, 10)) + pad * 2;
  cv.height = Math.ceil(lines.length * fontSize * 1.35) + pad * 2;
  ctx = cv.getContext('2d');
  roundRectPath(ctx, 0, 0, cv.width, cv.height, 18);
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.font = font;
  ctx.fillStyle = fg;
  ctx.textBaseline = 'top';
  lines.forEach((l, i) => ctx.fillText(l, pad, pad + i * fontSize * 1.35));
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthWrite: false,
  }));
  sp.scale.set((cv.width / cv.height) * worldH, worldH, 1);
  return sp;
}

function disposeGroup(g) {
  g.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m) => { if (m.map) m.map.dispose(); m.dispose(); });
    }
  });
}

/* ============================ scene setup =========================== */
function init() {
  const container = document.getElementById('scene-container');
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x9fc3e8);
  scene.fog = new THREE.Fog(0xa9c8e4, 150, 320);

  camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.set(74, 70, 74);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.minDistance = 25;
  controls.maxDistance = 200;
  controls.maxPolarAngle = Math.PI / 2 - 0.05;

  raycaster = new THREE.Raycaster();

  scene.add(new THREE.HemisphereLight(0xcfe5ff, 0x6f945f, 0.95));
  const sun = new THREE.DirectionalLight(0xfff4e0, 1.7);
  sun.position.set(70, 110, 45);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -120;
  sun.shadow.camera.right = 120;
  sun.shadow.camera.top = 120;
  sun.shadow.camera.bottom = -120;
  sun.shadow.camera.far = 400;
  scene.add(sun);

  staticGroup = new THREE.Group();
  scene.add(staticGroup);
  buildStatic();

  townGroup = new THREE.Group();
  scene.add(townGroup);

  renderer.domElement.addEventListener('pointerdown', (e) => {
    downXY = [e.clientX, e.clientY];
  });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!downXY) return;
    const dx = e.clientX - downXY[0];
    const dy = e.clientY - downXY[1];
    downXY = null;
    if (dx * dx + dy * dy > 36) return; // it was a drag, not a click
    pointerNDC.set(
      (e.clientX / window.innerWidth) * 2 - 1,
      -(e.clientY / window.innerHeight) * 2 + 1,
    );
    raycaster.setFromCamera(pointerNDC, camera);
    const hits = raycaster.intersectObjects(clickTargets.concat(staticClickTargets), false);
    if (hits.length) {
      let o = hits[0].object;
      while (o && !o.userData.info) o = o.parent;
      if (o && o.userData.info) { showInfoCard(o.userData.info); return; }
    }
    closeCard();
  });

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  document.getElementById('card-close').addEventListener('click', closeCard);

  animate();
}

/* ========================= static townscape ========================= */
function buildStatic() {
  // ground
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(240, 240),
    new THREE.MeshStandardMaterial({ color: 0x7aa86e, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  staticGroup.add(ground);

  // park quadrant (southeast): darker green circle
  const park = new THREE.Mesh(
    new THREE.CircleGeometry(30, 40),
    new THREE.MeshStandardMaterial({ color: 0x6a9c60, roughness: 1 }),
  );
  park.rotation.x = -Math.PI / 2;
  park.position.set(34, 0.012, 30);
  park.receiveShadow = true;
  staticGroup.add(park);

  const asphalt = new THREE.MeshStandardMaterial({ color: 0x3d434b, roughness: 0.95 });

  // crossing avenues
  const aveX = new THREE.Mesh(new THREE.PlaneGeometry(240, 8), asphalt);
  aveX.rotation.x = -Math.PI / 2;
  aveX.position.y = 0.015;
  aveX.receiveShadow = true;
  const aveZ = new THREE.Mesh(new THREE.PlaneGeometry(8, 240), asphalt);
  aveZ.rotation.x = -Math.PI / 2;
  aveZ.position.y = 0.015;
  aveZ.receiveShadow = true;
  staticGroup.add(aveX, aveZ);

  // rectangular loop road around the business district
  const L = CAR_LOOP;
  const loopMat = new THREE.MeshStandardMaterial({ color: 0x454b54, roughness: 0.95 });
  const mkStrip = (w, d, x, z) => {
    const s = new THREE.Mesh(new THREE.PlaneGeometry(w, d), loopMat);
    s.rotation.x = -Math.PI / 2;
    s.position.set(x, 0.02, z);
    s.receiveShadow = true;
    staticGroup.add(s);
  };
  mkStrip(2 * L + 6, 6, 0, -L);
  mkStrip(2 * L + 6, 6, 0, L);
  mkStrip(6, 2 * L + 6, -L, 0);
  mkStrip(6, 2 * L + 6, L, 0);

  // town square plaza (drawn above the avenue crossing)
  const plaza = new THREE.Mesh(
    new THREE.CircleGeometry(13, 48),
    new THREE.MeshStandardMaterial({ color: 0xb9bfc9, roughness: 0.9 }),
  );
  plaza.rotation.x = -Math.PI / 2;
  plaza.position.y = 0.03;
  plaza.receiveShadow = true;
  staticGroup.add(plaza);

  // trees
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2f, roughness: 1 });
  const leafMat = new THREE.MeshStandardMaterial({ color: 0x3e7d44, roughness: 1 });
  const addTree = (x, z, s = 1) => {
    const g = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.25 * s, 0.35 * s, 1.6 * s, 8), trunkMat);
    trunk.position.y = 0.8 * s;
    trunk.castShadow = true;
    const leaves = new THREE.Mesh(new THREE.ConeGeometry(2.2 * s, 4.6 * s, 8), leafMat);
    leaves.position.y = (1.6 + 2.3) * s;
    leaves.castShadow = true;
    g.add(trunk, leaves);
    g.position.set(x, 0, z);
    staticGroup.add(g);
  };
  for (let i = 0; i < 14; i++) {
    addTree(14 + rnd() * 40, 12 + rnd() * 38, 0.8 + rnd() * 0.7);
  }
  for (let i = 0; i < 8; i++) {
    const a = rnd() * Math.PI * 2;
    const r = 84 + rnd() * 14;
    addTree(Math.cos(a) * r, Math.sin(a) * r, 0.9 + rnd() * 0.8);
  }

  // streetlights along the avenues
  lampMat = new THREE.MeshStandardMaterial({
    color: 0x2ecc71, emissive: 0x2ecc71, emissiveIntensity: 0.85,
  });
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x39424e, roughness: 0.7 });
  const addLamp = (x, z) => {
    const g = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.18, 7, 8), poleMat);
    pole.position.y = 3.5;
    pole.castShadow = true;
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.55, 12, 12), lampMat);
    lamp.position.y = 7.2;
    lamp.userData.info = { type: 'streetlight' };
    g.add(pole, lamp);
    g.position.set(x, 0, z);
    staticGroup.add(g);
    staticClickTargets.push(lamp);
  };
  for (let x = -80; x <= 80; x += 20) { addLamp(x, 7); addLamp(x, -7); }
  for (let z = -60; z <= 60; z += 20) { addLamp(7, z); addLamp(-7, z); }

  // floating "TOWN SQUARE" marker label
  const sqLabel = makeLabel(['TOWN SQUARE'], { worldH: 3.2, fontSize: 40 });
  sqLabel.position.set(0, 15.5, 0);
  staticGroup.add(sqLabel);
}

/* ========================= dynamic townscape ======================== */
function buildPlazaCenter(d) {
  const p = d.pulse || {};
  const g = new THREE.Group();

  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(2.6, 3.2, 1.2, 24),
    new THREE.MeshStandardMaterial({ color: 0x8a93a3, roughness: 0.8 }),
  );
  base.position.y = 0.6;
  base.castShadow = true;
  const column = new THREE.Mesh(
    new THREE.CylinderGeometry(1.1, 1.4, 9, 16),
    new THREE.MeshStandardMaterial({ color: 0x9aa4b5, roughness: 0.75 }),
  );
  column.position.y = 5.7;
  column.castShadow = true;
  const orb = new THREE.Mesh(
    new THREE.SphereGeometry(1.5, 20, 20),
    new THREE.MeshStandardMaterial({
      color: 0x2f6fed, emissive: 0x2f6fed, emissiveIntensity: 0.55, roughness: 0.3,
    }),
  );
  orb.position.y = 11.4;
  const info = { type: 'square' };
  base.userData.info = info;
  column.userData.info = info;
  orb.userData.info = info;
  g.add(base, column, orb);
  clickTargets.push(base, column, orb);

  const label = makeLabel([
    'TODAY',
    `${p.calls_answered_today ?? 0} answered · ${p.missed_calls_today ?? 0} missed`,
    `${p.voicemails_waiting ?? 0} voicemail · ${p.unread_texts ?? 0} texts`,
  ], { worldH: 4.6 });
  label.position.y = 15.5;
  g.add(label);

  townGroup.add(g);
}

function buildBuilding(info, spot) {
  const volume = info.today_volume || 0;
  const active = info.active_conversations || 0;
  const h = THREE.MathUtils.clamp(8 + volume * 1.4, 8, 30);
  const w = 16, dep = 13;

  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, dep),
    new THREE.MeshStandardMaterial({ color: 0x93a7bd, roughness: 0.85 }),
  );
  body.position.y = h / 2;
  body.castShadow = true;
  body.receiveShadow = true;

  const roof = new THREE.Mesh(
    new THREE.BoxGeometry(w + 1.4, 1, dep + 1.4),
    new THREE.MeshStandardMaterial({ color: 0x46566b, roughness: 0.9 }),
  );
  roof.position.y = h + 0.5;
  roof.castShadow = true;

  const door = new THREE.Mesh(
    new THREE.PlaneGeometry(3, 4),
    new THREE.MeshStandardMaterial({ color: 0x2c3a4c, roughness: 0.6 }),
  );
  door.position.set(0, 2, dep / 2 + 0.06);

  const infoRef = { type: 'building', building: info };
  body.userData.info = infoRef;
  roof.userData.info = infoRef;
  g.add(body, roof, door);
  clickTargets.push(body, roof);

  // windows: lit = active conversations
  const litMat = new THREE.MeshStandardMaterial({
    color: 0x6b5f36, emissive: 0xffc861, emissiveIntensity: 1.0,
  });
  const darkMat = new THREE.MeshStandardMaterial({
    color: 0x243040, roughness: 0.35, metalness: 0.4,
  });
  const rows = Math.max(1, Math.floor((h - 4) / 3.6));
  let wi = 0;
  const addWin = (x, y, z, ry) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 1.8), wi < active ? litMat : darkMat);
    m.position.set(x, y, z);
    m.rotation.y = ry;
    g.add(m);
    wi += 1;
  };
  for (let r = 0; r < rows; r += 1) {
    const y = 5.4 + r * 3.6;
    if (y > h - 1.6) break;
    for (let c = 0; c < 4; c += 1) {
      const x = -w / 2 + ((c + 0.5) * w) / 4;
      addWin(x, y, dep / 2 + 0.06, 0);
      addWin(x, y, -dep / 2 - 0.06, Math.PI);
    }
    for (let c = 0; c < 3; c += 1) {
      const z = -dep / 2 + ((c + 0.5) * dep) / 3;
      addWin(w / 2 + 0.06, y, z, Math.PI / 2);
      addWin(-w / 2 - 0.06, y, z, -Math.PI / 2);
    }
  }

  const label = makeLabel(
    [info.name, `${volume} today · ${active} active`],
    { worldH: 5 },
  );
  label.position.y = h + 5;
  g.add(label);

  g.position.set(spot.x, 0, spot.z);
  townGroup.add(g);
}

const HOUSE_COLORS = [0xe8d8b8, 0xd8e4e8, 0xe8cfc0, 0xdce8d0, 0xe4d8ec, 0xd0dce8, 0xead9c2, 0xcfe0d8];

function buildHouse(lead, index) {
  const a = (index / HOUSE_SLOTS) * Math.PI * 2 + Math.PI / HOUSE_SLOTS;
  const x = Math.cos(a) * HOUSE_RING_R;
  const z = Math.sin(a) * HOUSE_RING_R;

  const g = new THREE.Group();
  const base = new THREE.Mesh(
    new THREE.BoxGeometry(7, 3.6, 6),
    new THREE.MeshStandardMaterial({ color: HOUSE_COLORS[index % HOUSE_COLORS.length], roughness: 0.9 }),
  );
  base.position.y = 1.8;
  base.castShadow = true;
  base.receiveShadow = true;

  const roof = new THREE.Mesh(
    new THREE.ConeGeometry(5.4, 2.8, 4),
    new THREE.MeshStandardMaterial({ color: 0x7d4a3a, roughness: 0.9 }),
  );
  roof.position.y = 3.6 + 1.4;
  roof.rotation.y = Math.PI / 4;
  roof.castShadow = true;

  const door = new THREE.Mesh(
    new THREE.PlaneGeometry(1.5, 2.6),
    new THREE.MeshStandardMaterial({ color: 0x4a3527, roughness: 0.8 }),
  );
  door.position.set(0, 1.3, 3.02);

  const chimney = new THREE.Mesh(
    new THREE.BoxGeometry(1, 2.2, 1),
    new THREE.MeshStandardMaterial({ color: 0x9a8f85, roughness: 0.9 }),
  );
  chimney.position.set(2, 5.4, 0);

  const infoRef = { type: 'house', lead };
  base.userData.info = infoRef;
  roof.userData.info = infoRef;
  g.add(base, roof, door, chimney);
  clickTargets.push(base, roof);

  // red flag when a callback is owed
  if (lead.status === 'callback_owed') {
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.08, 0.08, 4.4, 8),
      new THREE.MeshStandardMaterial({ color: 0x555f6a, roughness: 0.6 }),
    );
    pole.position.set(3.2, 6.4, 2.2);
    const flag = new THREE.Mesh(
      new THREE.PlaneGeometry(2.4, 1.5),
      new THREE.MeshStandardMaterial({ color: 0xd63c2f, side: THREE.DoubleSide, roughness: 0.7 }),
    );
    flag.position.set(4.5, 8.1, 2.2);
    g.add(pole, flag);
    wavingFlags.push(flag);
  }

  const label = makeLabel([lead.name], {
    worldH: 3,
    fontSize: 40,
    bg: lead.status === 'callback_owed' ? 'rgba(150,40,32,0.88)' : 'rgba(18,26,36,0.82)',
  });
  label.position.y = 10.6;
  g.add(label);

  g.position.set(x, 0, z);
  // face the town center
  g.rotation.y = Math.atan2(-x, -z);
  townGroup.add(g);
}

/* car path: rectangle loop at +/- CAR_LOOP */
function loopPos(dist) {
  const L = CAR_LOOP;
  const P = 8 * L;
  let d = ((dist % P) + P) % P;
  const pts = [[-L, -L], [L, -L], [L, L], [-L, L]];
  for (let i = 0; i < 4; i += 1) {
    const a = pts[i];
    const b = pts[(i + 1) % 4];
    const segLen = 2 * L;
    if (d <= segLen) {
      const t = d / segLen;
      return {
        x: a[0] + (b[0] - a[0]) * t,
        z: a[1] + (b[1] - a[1]) * t,
        dx: b[0] - a[0],
        dz: b[1] - a[1],
      };
    }
    d -= segLen;
  }
  return { x: -L, z: -L, dx: 1, dz: 0 };
}

function addCar(call, index) {
  const color = CAR_COLORS[index % CAR_COLORS.length];
  const g = new THREE.Group();

  const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.25 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(4.6, 1.2, 2.3), bodyMat);
  body.position.y = 0.95;
  body.castShadow = true;
  const cabin = new THREE.Mesh(
    new THREE.BoxGeometry(2.3, 1.0, 2.0),
    new THREE.MeshStandardMaterial({ color: 0x2c3e50, roughness: 0.25, metalness: 0.4 }),
  );
  cabin.position.set(-0.2, 1.95, 0);
  cabin.castShadow = true;

  const wheelGeo = new THREE.CylinderGeometry(0.48, 0.48, 0.4, 14);
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x1c1f24, roughness: 0.9 });
  [[1.5, 1.05], [1.5, -1.05], [-1.5, 1.05], [-1.5, -1.05]].forEach(([wx, wz]) => {
    const wheel = new THREE.Mesh(wheelGeo, wheelMat);
    wheel.rotation.x = Math.PI / 2;
    wheel.position.set(wx, 0.48, wz);
    g.add(wheel);
  });

  // headlights
  const lightMat = new THREE.MeshStandardMaterial({
    color: 0xfff6c9, emissive: 0xffedb0, emissiveIntensity: 1.2,
  });
  [-0.7, 0.7].forEach((lz) => {
    const hl = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 10), lightMat);
    hl.position.set(2.32, 0.95, lz);
    g.add(hl);
  });

  const infoRef = { type: 'car', call };
  body.userData.info = infoRef;
  cabin.userData.info = infoRef;
  g.add(body, cabin);
  clickTargets.push(body, cabin);

  const startDist = (index * (8 * CAR_LOOP)) / Math.max(1, 6);
  const p = loopPos(startDist);
  g.position.set(p.x, 0, p.z);
  g.rotation.y = Math.atan2(p.dx, p.dz);
  townGroup.add(g);

  cars.push({
    group: g, call, dist: startDist, speed: 9 + index * 1.4,
  });
}

/* ============================ data refresh ========================== */
function computeWaiting(d) {
  const owed = (d.leads || []).filter((l) => l.status === 'callback_owed');
  const unheard = (d.voicemails || []).filter((v) => !v.listened);
  const missed = (d.missed_calls || []).filter((m) => !m.called_back);
  return { owed, unheard, missed, any: (owed.length + unheard.length + missed.length) > 0 };
}

function updateWaitingVisuals(d) {
  const w = computeWaiting(d);
  const col = w.any ? 0xe67e22 : 0x2ecc71;
  lampMat.color.setHex(col);
  lampMat.emissive.setHex(col);
  const dot = document.getElementById('live-dot');
  dot.classList.toggle('waiting', w.any);
  document.getElementById('live-label').textContent = w.any ? 'NEEDS YOU' : 'LIVE';
}

function updateHud(d) {
  const now = new Date();
  document.getElementById('updated-at').textContent =
    'Updated ' + now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  document.getElementById('mock-note').style.display = d.source === 'mock' ? '' : 'none';
}

function rebuildTown() {
  if (townGroup) {
    scene.remove(townGroup);
    disposeGroup(townGroup);
  }
  townGroup = new THREE.Group();
  scene.add(townGroup);
  clickTargets = [];
  cars = [];
  wavingFlags = [];

  const d = townData;
  buildPlazaCenter(d);
  (d.buildings || []).slice(0, 3).forEach((b, i) => buildBuilding(b, BUILDING_SPOTS[i]));
  (d.leads || []).slice(0, HOUSE_SLOTS).forEach((lead, i) => buildHouse(lead, i));
  (d.live_calls || []).slice(0, 6).forEach((call, i) => addCar(call, i));

  updateWaitingVisuals(d);
  updateHud(d);
}

async function refreshData() {
  try {
    const res = await fetch(DATA_URL + '?t=' + Date.now());
    if (!res.ok) throw new Error('HTTP ' + res.status);
    townData = await res.json();
    rebuildTown();
    document.getElementById('loading').classList.add('hidden');
    document.getElementById('error-banner').classList.add('hidden');
  } catch (e) {
    const banner = document.getElementById('error-banner');
    banner.textContent = 'Could not load data.json (' + e.message + '). The town needs data.json next to index.html.';
    banner.classList.remove('hidden');
  }
}

/* ============================== info card =========================== */
function closeCard() {
  document.getElementById('stats-card').classList.add('hidden');
}

function kvRow(k, v) {
  return `<div class="kv"><span class="k">${esc(k)}</span><span class="v">${v}</span></div>`;
}

function statusBadge(status) {
  const map = {
    callback_owed: ['<span class="badge red">callback owed</span>', 'Callback owed'],
    new: ['<span class="badge green">new</span>', 'New'],
    contacted: ['<span class="badge amber">contacted</span>', 'Contacted'],
    quoted: ['<span class="badge amber">quoted</span>', 'Quoted'],
  };
  return map[status] || ['', esc(status)];
}

function openCard(titleHtml, subtitle, bodyHtml) {
  document.getElementById('card-title').innerHTML = titleHtml;
  document.getElementById('card-subtitle').textContent = subtitle;
  document.getElementById('card-body').innerHTML = bodyHtml;
  document.getElementById('stats-card').classList.remove('hidden');
}

function buildingLeads(buildingId) {
  const leads = townData.leads || [];
  return leads.filter((l) => {
    const s = (l.listing || '').toLowerCase();
    if (buildingId === 'countertops') return /counter|quartz|granite|vanity|stone/.test(s);
    if (buildingId === 'rentals') return /rent|townhouse|bed|apartment/.test(s);
    return !/counter|quartz|granite|vanity|stone|rent|townhouse|bed|apartment/.test(s);
  });
}

function showInfoCard(info) {
  const d = townData;
  if (info.type === 'square') {
    const p = d.pulse || {};
    const w = computeWaiting(d);
    let body = kvRow('Calls answered', p.calls_answered_today ?? 0)
      + kvRow('Missed calls', p.missed_calls_today ?? 0)
      + kvRow('Voicemails waiting', p.voicemails_waiting ?? 0)
      + kvRow('Unread texts', p.unread_texts ?? 0);

    if (w.unheard.length) {
      body += '<div class="section-title">Voicemails to hear</div>';
      w.unheard.forEach((v) => {
        body += `<div class="list-item"><span class="who">${esc(v.caller_name)}</span>`
          + `<span class="meta"> · ${esc(v.caller_number)} · ${fmtAgo(v.received_at)} · ${fmtDur(v.duration_sec)}</span>`
          + `<div class="snippet">${esc(v.transcript || '')}</div></div>`;
      });
    }
    if (w.missed.length) {
      body += '<div class="section-title">Missed calls needing callback</div>';
      w.missed.forEach((m) => {
        body += `<div class="list-item"><span class="who">${esc(m.caller_name)}</span>`
          + `<span class="meta"> · ${esc(m.caller_number)} · ${m.line || ''} line · ${fmtAgo(m.received_at)}</span></div>`;
      });
    }
    const unread = (d.texts || []).filter((t) => !t.read);
    if (unread.length) {
      body += '<div class="section-title">Unread texts</div>';
      unread.forEach((t) => {
        body += `<div class="list-item"><span class="who">${esc(t.from_name)}</span>`
          + `<span class="meta"> · ${t.listing ? esc(t.listing) + ' · ' : ''}${fmtAgo(t.received_at)}</span>`
          + `<div class="snippet">${esc(t.body || '')}</div></div>`;
      });
    }
    openCard('Town Square', "Today's pulse across every line", body);
  } else if (info.type === 'building') {
    const b = info.building;
    const leads = buildingLeads(b.id);
    let body = kvRow("Today's volume", b.today_volume ?? 0)
      + kvRow('Active conversations', b.active_conversations ?? 0);
    if (leads.length) {
      body += '<div class="section-title">Hot leads on this line</div>';
      leads.forEach((l) => {
        const [badge] = statusBadge(l.status);
        body += `<div class="list-item"><span class="who">${esc(l.name)}</span>${badge}`
          + `<div class="meta">${esc(l.listing || '')} · last activity ${fmtAgo(l.last_activity_at)}</div>`
          + (l.note ? `<div class="snippet">${esc(l.note)}</div>` : '') + '</div>';
      });
    }
    openCard(esc(b.name), 'Line of business', body);
  } else if (info.type === 'car') {
    const c = info.call;
    const body = kvRow('Caller', esc(c.caller_name || 'Unknown'))
      + kvRow('Number', esc(c.caller_number || '—'))
      + kvRow('Line', esc(c.line || '—'))
      + kvRow('Talking for', fmtDur(c.duration_sec))
      + kvRow('Started', fmtClock(c.started_at));
    openCard('Live call', 'Happening right now', body);
  } else if (info.type === 'house') {
    const l = info.lead;
    const [badge] = statusBadge(l.status);
    const body = kvRow('Listing', esc(l.listing || '—'))
      + kvRow('Phone', esc(l.phone || '—'))
      + kvRow('Last activity', fmtAgo(l.last_activity_at))
      + kvRow('Waiting', (l.unanswered_hours ?? 0) + 'h')
      + (l.note ? '<div class="section-title">Note</div><div class="list-item"><div class="snippet">'
        + esc(l.note) + '</div></div>' : '');
    openCard(esc(l.name) + ' ' + badge, 'Hot lead', body);
  } else if (info.type === 'streetlight') {
    const w = computeWaiting(d);
    const n = w.owed.length + w.unheard.length + w.missed.length;
    const body = n === 0
      ? kvRow('Status', '<span class="badge green">all clear</span>')
        + '<div class="section-title">Nothing waiting</div><div class="list-item">No callbacks owed, no unheard voicemails, no missed calls.</div>'
      : kvRow('Status', '<span class="badge amber">attention</span>')
        + kvRow('Callbacks owed', w.owed.length)
        + kvRow('Unheard voicemails', w.unheard.length)
        + kvRow('Missed calls', w.missed.length);
    openCard('Streetlights', 'Town-wide waiting status', body);
  }
}

/* ============================ animation ============================= */
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.1);
  const t = clock.elapsedTime;

  for (const c of cars) {
    c.dist = (c.dist + c.speed * dt) % (8 * CAR_LOOP);
    const p = loopPos(c.dist);
    c.group.position.set(p.x, 0, p.z);
    c.group.rotation.y = Math.atan2(p.dx, p.dz);
  }
  for (let i = 0; i < wavingFlags.length; i += 1) {
    wavingFlags[i].rotation.y = Math.sin(t * 4 + i * 1.7) * 0.35;
  }

  controls.update();
  renderer.render(scene, camera);
}

/* ================================ boot ============================== */
try {
  init();
  refreshData();
  setInterval(refreshData, POLL_MS);
} catch (e) {
  const banner = document.getElementById('error-banner');
  banner.textContent = 'WebGL could not start: ' + e.message;
  banner.classList.remove('hidden');
  document.getElementById('loading').classList.add('hidden');
}
