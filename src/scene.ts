import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { TABLE, toTable, type End, type Team } from "./rules.ts";
import { CENTRE, CameraRig, toWorld, type CameraMode } from "./rig.ts";
import { SWAP } from "./swap.ts";
import { aimTexture, concreteTexture, feltTexture, glowTexture, markingsTexture, neonTexture, tableTexture } from "./textures.ts";

export const TEAM_COLORS = ["#ff7a1a", "#27d3ff"] as const;
/** Neon on both end walls. Split over two lines so it stays big enough to read on a phone. */
export const WALL_SIGN = ["Everyday I'm", "Shuffling"] as const;

const W = TABLE.width;
const L = TABLE.length;
const R = TABLE.puckRadius;
const H = TABLE.puckHeight;
export const GUTTER_W = 0.13;
export const GUTTER_Y = -0.075;
export const PIT_LEN = 0.2;
const RAIL_W = 0.05;
const FULL_W = W + 2 * (GUTTER_W + RAIL_W);
const FLOOR_Y = -0.92;
/** Lamp fixtures render in the main view only, never in the top-down head cam. */
const LAMP_LAYER = 1;

/** The hall around the active table (metres, world frame; the active table runs z = 0 → -L). */
const HALL = {
  halfWidth: 8.6,
  wallGap: 2.2,
  /** x of the neighbouring shuffleboards, one each side. */
  boards: 2.7,
  /** x of the pool-table rows, and the z offsets of the two tables in each row from the hall centre. */
  pool: 5.6,
  poolZ: [2.2, -2.2],
} as const;
const HEMI = 0.35;
const ENV_INTENSITY = 0.35;
const EXPOSURE = 1.05;
const FOG_NEAR = 7;
const FOG_FAR = 18;

/** Sand beads drawn on the table. Visual only; the physics has its own field (`SAND` in physics.ts). */
const SAND_GRAINS = 2200;
const SAND_BUCKET = 0.1;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PuckView {
  group: THREE.Group;
  cap: THREE.MeshStandardMaterial;
  ring: THREE.Mesh;
}

interface TableMats {
  surface: THREE.Material;
  markings: THREE.Material;
  edgeWood: THREE.Material;
  steel: THREE.Material;
  dark: THREE.Material;
  rubber: THREE.Material;
  apron: THREE.Material;
  leg: THREE.Material;
  strips: [THREE.Material, THREE.Material];
  endStrip: THREE.Material;
}

function box(w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = false;
  m.receiveShadow = true;
  return m;
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** A full table: playing surface, gutters, rails, and an identical pit and bumper at each end. */
function buildShuffleboard(t: THREE.Object3D, m: TableMats, x0: number): void {
  const surface = new THREE.Mesh(new THREE.PlaneGeometry(W, L), m.surface);
  surface.rotation.x = -Math.PI / 2;
  surface.position.set(x0, 0, -L / 2);
  t.add(surface);
  const marks = new THREE.Mesh(surface.geometry, m.markings);
  marks.rotation.x = -Math.PI / 2;
  marks.position.set(x0, 0.0004, -L / 2);
  // Over the surface's clear coat but under the aim guide and lamp glow.
  marks.renderOrder = -1;
  t.add(marks);

  t.add(box(W, 0.08, L, m.edgeWood, x0, -0.041, -L / 2));
  const outerX = W / 2 + GUTTER_W + RAIL_W / 2;
  const zFar = -(L + PIT_LEN);
  const zNear = PIT_LEN;
  const bodyLen = zNear - zFar;
  const bodyMid = -L / 2;

  for (const s of [-1, 1]) {
    t.add(box(GUTTER_W, 0.01, bodyLen, m.steel, x0 + s * (W / 2 + GUTTER_W / 2), GUTTER_Y - 0.005, bodyMid));
    t.add(box(RAIL_W, 0.13, bodyLen, m.dark, x0 + s * outerX, -0.03, bodyMid));
    const strip = m.strips[s < 0 ? 0 : 1];
    t.add(box(0.012, 0.012, bodyLen, strip, x0 + s * (W / 2 + GUTTER_W + 0.006), 0.036, bodyMid));
    t.add(box(0.01, 0.02, bodyLen, strip, x0 + s * (outerX + RAIL_W / 2 + 0.005), -0.22, bodyMid));
  }

  for (const mirror of [(z: number) => z, (z: number) => -L - z]) {
    t.add(box(FULL_W, 0.01, PIT_LEN, m.steel, x0, GUTTER_Y - 0.005, mirror(-(L + PIT_LEN / 2))));
    t.add(box(FULL_W, 0.2, 0.06, m.dark, x0, 0.01, mirror(zFar - 0.03)));
    t.add(box(FULL_W - 0.02, 0.1, 0.03, m.rubber, x0, 0.0, mirror(zFar + 0.012)));
    t.add(box(FULL_W, 0.014, 0.014, m.endStrip, x0, 0.115, mirror(zFar - 0.03)));
  }

  t.add(box(FULL_W, 0.2, bodyLen + 0.12, m.apron, x0, -0.19, bodyMid));
  for (const z of [0, -L / 2, -L]) {
    for (const s of [-1, 1]) t.add(box(0.1, -FLOOR_Y - 0.28, 0.1, m.leg, x0 + s * (FULL_W / 2 - 0.08), (FLOOR_Y - 0.28) / 2, z));
  }
}

/** Merge a static group into one mesh per material, so the whole hall costs a handful of draw calls. */
function bake(group: THREE.Group): THREE.Mesh[] {
  group.updateMatrixWorld(true);
  const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const order = new Map<THREE.Material, number>();
  group.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const mat = o.material as THREE.Material;
    order.set(mat, o.renderOrder);
    const g = (o.geometry as THREE.BufferGeometry).clone().applyMatrix4(o.matrixWorld);
    const list = byMat.get(mat) ?? [];
    list.push(g);
    byMat.set(mat, list);
  });
  const out: THREE.Mesh[] = [];
  byMat.forEach((list, mat) => {
    // mergeGeometries needs all-indexed or all-plain input.
    const geos = list.every((g) => g.index) ? list : list.map((g) => (g.index ? g.toNonIndexed() : g));
    const merged = mergeGeometries(geos, false);
    list.forEach((g) => g.dispose());
    if (!merged) return;
    const mesh = new THREE.Mesh(merged, mat);
    mesh.receiveShadow = true;
    mesh.renderOrder = order.get(mat) ?? 0;
    mesh.matrixAutoUpdate = false;
    out.push(mesh);
  });
  return out;
}

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(50, 1, 0.05, 60);
  readonly headCam = new THREE.OrthographicCamera(-0.62, 0.62, 1.6, -1.6, 0.1, 10);
  readonly table = new THREE.Group();
  /**
   * Everything placed in shooter-relative coordinates: weights and the aim
   * guide. For end 1 it is turned half round about the table centre.
   */
  readonly play = new THREE.Group();
  readonly aim: THREE.Mesh;
  inset: Rect | null = null;

  private endNow: End = 0;
  /** Every scripted camera move; see `CAMERA` in rig.ts for the feel knobs. */
  private rig = new CameraRig();
  private time = 0;
  private neon: THREE.MeshBasicMaterial[] = [];
  private tmp = new THREE.Vector3();
  private chrome: THREE.MeshStandardMaterial;
  private spots: THREE.SpotLight[] = [];
  private hemi = new THREE.HemisphereLight(0x8090a0, 0x201810, HEMI);
  private fog = new THREE.Fog(0x0a0b0e, FOG_NEAR, FOG_FAR);

  private sand!: THREE.InstancedMesh;
  /** Per grain: absolute table x, d, scale, yaw; and which bucket (by d) it is filed in, -1 once in a gutter. */
  private grain = new Float32Array(SAND_GRAINS * 4);
  private grainBucket = new Int16Array(SAND_GRAINS);
  private buckets: number[][] = [];
  private dummy = new THREE.Object3D();

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = EXPOSURE;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = false;

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = ENV_INTENSITY;
    this.scene.background = new THREE.Color(0x0a0b0e);
    this.scene.fog = this.fog;

    this.chrome = new THREE.MeshStandardMaterial({ color: 0xd9dee4, metalness: 1, roughness: 0.26 });

    this.camera.layers.enable(LAMP_LAYER);
    this.aimHeadCam();

    const aniso = this.renderer.capabilities.getMaxAnisotropy();
    const surface = new THREE.MeshPhysicalMaterial({
      map: tableTexture(aniso),
      roughness: 0.32,
      clearcoat: 1,
      clearcoatRoughness: 0.12,
    });
    // Matte paint over the clear coat: the lamps and room still gleam on the wood, but not on the lines.
    const markings = new THREE.MeshStandardMaterial({
      map: markingsTexture(aniso),
      roughness: 0.9,
      metalness: 0,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    this.buildTable(surface, markings);
    this.buildSand();
    this.buildRoom();
    this.buildHall(surface, markings);
    this.buildLights();
    this.scene.add(this.play);

    const aimMat = new THREE.MeshBasicMaterial({
      map: aimTexture(),
      transparent: true,
      depthWrite: false,
      color: 0xffffff,
      blending: THREE.AdditiveBlending,
    });
    this.aim = new THREE.Mesh(new THREE.PlaneGeometry(0.09, 1), aimMat);
    this.aim.geometry.translate(0, 0.5, 0);
    this.aim.geometry.rotateX(-Math.PI / 2);
    this.aim.position.y = 0.003;
    this.aim.visible = false;
    this.play.add(this.aim);
  }

  private buildTable(surface: THREE.Material, markings: THREE.Material): void {
    const t = this.table;
    this.scene.add(t);
    buildShuffleboard(t, {
      surface,
      markings,
      edgeWood: new THREE.MeshStandardMaterial({ color: 0x5a3a1c, roughness: 0.55 }),
      steel: new THREE.MeshStandardMaterial({ color: 0x3a3f45, metalness: 0.85, roughness: 0.45 }),
      dark: new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.7, metalness: 0.2 }),
      rubber: new THREE.MeshStandardMaterial({ color: 0x1b1b1d, roughness: 0.95 }),
      apron: new THREE.MeshStandardMaterial({ color: 0x1d2024, roughness: 0.6, metalness: 0.4 }),
      leg: new THREE.MeshStandardMaterial({ color: 0x24272b, metalness: 0.7, roughness: 0.4 }),
      strips: [new THREE.MeshBasicMaterial({ color: TEAM_COLORS[0] }), new THREE.MeshBasicMaterial({ color: TEAM_COLORS[1] })],
      endStrip: new THREE.MeshBasicMaterial({ color: 0xffc21a }),
    }, 0);
    t.traverse((o) => {
      if (o instanceof THREE.Mesh) o.receiveShadow = true;
    });
  }

  /* ---------- sand ---------- */

  private buildSand(): void {
    const geo = new THREE.IcosahedronGeometry(1, 0);
    const mat = new THREE.MeshStandardMaterial({ color: 0xf6ecd4, roughness: 0.45, metalness: 0, emissive: 0x2a2418 });
    this.sand = new THREE.InstancedMesh(geo, mat, SAND_GRAINS);
    this.sand.frustumCulled = false;
    this.sand.castShadow = false;
    this.sand.receiveShadow = false;
    this.buckets = Array.from({ length: Math.ceil(L / SAND_BUCKET) + 1 }, () => []);
    this.scene.add(this.sand);
    this.sprinkleSand(1);
  }

  /** Fresh sand for a new round: beads spread down the table, densest along the middle of the lane. */
  sprinkleSand(seed: number): void {
    const rand = rng(seed * 7919 + 17);
    this.buckets.forEach((b) => (b.length = 0));
    for (let i = 0; i < SAND_GRAINS; i++) {
      const across = (rand() + rand() + rand()) / 1.5 - 1;
      const x = across * (W / 2 - 0.012);
      const d = 0.02 + rand() * (L - 0.04);
      const g = i * 4;
      this.grain[g] = x;
      this.grain[g + 1] = d;
      this.grain[g + 2] = 0.0028 + rand() * rand() * 0.0034;
      this.grain[g + 3] = rand() * Math.PI * 2;
      const b = Math.floor(d / SAND_BUCKET);
      this.grainBucket[i] = b;
      this.buckets[b].push(i);
      this.placeGrain(i, 0);
    }
    this.sand.instanceMatrix.needsUpdate = true;
  }

  private placeGrain(i: number, y: number): void {
    const g = i * 4;
    const s = this.grain[g + 2];
    const o = this.dummy;
    o.position.set(this.grain[g], y + s * 0.35, -this.grain[g + 1]);
    o.rotation.set(0, this.grain[g + 3], 0);
    o.scale.set(s, s * 0.55, s);
    o.updateMatrix();
    this.sand.setMatrixAt(i, o.matrix);
  }

  /** A weight sliding at shooter-relative (`x`, `d`) shoves the beads under it aside; any pushed off the edge drop into the gutter. */
  plowSand(x: number, d: number): void {
    const p = toTable(this.endNow, x, d);
    const reach = R + 0.004;
    const b0 = Math.floor(p.d / SAND_BUCKET);
    let moved = false;
    for (let b = b0 - 1; b <= b0 + 1; b++) {
      const list = this.buckets[b];
      if (!list) continue;
      for (let k = list.length - 1; k >= 0; k--) {
        const i = list[k];
        const g = i * 4;
        const dx = this.grain[g] - p.x;
        const dd = this.grain[g + 1] - p.d;
        const dist2 = dx * dx + dd * dd;
        if (dist2 >= reach * reach) continue;
        const dist = Math.sqrt(dist2);
        const nx = dist > 1e-5 ? dx / dist : i % 2 ? 1 : -1;
        const nd = dist > 1e-5 ? dd / dist : 0;
        const push = reach + ((i * 37) % 11) * 0.0004;
        this.grain[g] = p.x + nx * push;
        this.grain[g + 1] = p.d + nd * push;
        moved = true;
        const nb = Math.floor(this.grain[g + 1] / SAND_BUCKET);
        const offTable = Math.abs(this.grain[g]) > W / 2 - 0.002 || this.grain[g + 1] < 0 || this.grain[g + 1] > L;
        if (offTable || nb !== b) {
          list.splice(k, 1);
          if (offTable) {
            this.grainBucket[i] = -1;
            const side = Math.sign(this.grain[g]) || 1;
            if (this.grain[g + 1] >= 0 && this.grain[g + 1] <= L) this.grain[g] = side * (W / 2 + 0.015 + ((i * 13) % 7) * 0.012);
            this.placeGrain(i, GUTTER_Y);
            continue;
          }
          this.grainBucket[i] = nb;
          this.buckets[nb]?.push(i);
        }
        this.placeGrain(i, 0);
      }
    }
    if (moved) this.sand.instanceMatrix.needsUpdate = true;
  }

  /* ---------- room and hall ---------- */

  private buildRoom(): void {
    const floorTex = concreteTexture();
    floorTex.repeat.set(11, 11);
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(40, 40),
      new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.92, metalness: 0.05 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, FLOOR_Y, -L / 2);
    floor.receiveShadow = true;
    this.scene.add(floor);

    const wallMat = new THREE.MeshStandardMaterial({ color: 0x1a1c20, roughness: 0.9 });
    const signMat = new THREE.MeshBasicMaterial({
      map: neonTexture(WALL_SIGN, "#ff7a1a", "#ffd6b0"),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.neon.push(signMat);

    const stripe = document.createElement("canvas");
    stripe.width = 256;
    stripe.height = 32;
    const s = stripe.getContext("2d")!;
    s.fillStyle = "#111";
    s.fillRect(0, 0, 256, 32);
    s.fillStyle = "#ffc21a";
    for (let x = -32; x < 256; x += 32) {
      s.beginPath();
      s.moveTo(x, 32);
      s.lineTo(x + 16, 32);
      s.lineTo(x + 32, 0);
      s.lineTo(x + 16, 0);
      s.fill();
    }
    const stripeTex = new THREE.CanvasTexture(stripe);
    stripeTex.colorSpace = THREE.SRGBColorSpace;
    stripeTex.wrapS = THREE.RepeatWrapping;
    stripeTex.repeat.set(21, 1);
    const hazardMat = new THREE.MeshStandardMaterial({ map: stripeTex, roughness: 0.8 });

    // One end wall behind each end of the table, so whichever way you shoot you face the sign.
    const hallW = HALL.halfWidth * 2;
    for (const end of [0, 1] as End[]) {
      const face = new THREE.Group();
      face.position.set(0, 0, end === 0 ? -L - HALL.wallGap : HALL.wallGap);
      face.rotation.y = end === 0 ? 0 : Math.PI;
      const wall = new THREE.Mesh(new THREE.PlaneGeometry(hallW, 6), wallMat);
      wall.position.y = 2;
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(2.9, 1.45), signMat);
      sign.position.set(0, 1.3, 0.05);
      const hazard = new THREE.Mesh(new THREE.PlaneGeometry(hallW, 0.25), hazardMat);
      hazard.position.set(0, FLOOR_Y + 0.4, 0.01);
      face.add(wall, sign, hazard);
      this.scene.add(face);
    }

    const poolSign = new THREE.MeshBasicMaterial({
      map: neonTexture(["POOL"], "#27d3ff", "#c8f4ff"),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.neon.push(poolSign);
    const hallL = L + HALL.wallGap * 2;
    for (const s of [-1, 1]) {
      const side = new THREE.Group();
      side.position.set(s * HALL.halfWidth, 0, -L / 2);
      side.rotation.y = -s * (Math.PI / 2);
      const wall = new THREE.Mesh(new THREE.PlaneGeometry(hallL, 6), wallMat);
      wall.position.y = 2;
      const hazard = new THREE.Mesh(new THREE.PlaneGeometry(hallL, 0.25), hazardMat);
      hazard.position.set(0, FLOOR_Y + 0.4, 0.01);
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 0.9), poolSign);
      sign.position.set(0, 1.5, 0.05);
      side.add(wall, hazard, sign);
      this.scene.add(side);
    }
  }

  /** The rest of the room: a shuffleboard either side and a row of pool tables beyond each, all static and baked. */
  private buildHall(surface: THREE.Material, markings: THREE.Material): void {
    const hall = new THREE.Group();
    const rand = rng(29);
    const dim = (hex: number) => new THREE.MeshBasicMaterial({ color: hex });
    const tableMats: TableMats = {
      surface,
      markings,
      edgeWood: new THREE.MeshStandardMaterial({ color: 0x5a3a1c, roughness: 0.6 }),
      steel: new THREE.MeshStandardMaterial({ color: 0x3a3f45, metalness: 0.8, roughness: 0.5 }),
      dark: new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.75 }),
      rubber: new THREE.MeshStandardMaterial({ color: 0x1b1b1d, roughness: 0.95 }),
      apron: new THREE.MeshStandardMaterial({ color: 0x1d2024, roughness: 0.6, metalness: 0.4 }),
      leg: new THREE.MeshStandardMaterial({ color: 0x24272b, metalness: 0.7, roughness: 0.4 }),
      strips: [dim(0x8a4412), dim(0x16728a)],
      endStrip: dim(0x8a6a10),
    };
    const shade = new THREE.MeshStandardMaterial({ color: 0x2c3a34, metalness: 0.6, roughness: 0.45, side: THREE.DoubleSide });
    const bulb = new THREE.MeshBasicMaterial({ color: 0xfff1d6 });
    const cord = new THREE.MeshBasicMaterial({ color: 0x050505 });
    const pool = new THREE.MeshBasicMaterial({
      map: glowTexture(),
      color: 0xffd9a8,
      transparent: true,
      opacity: 0.32,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const lightPool = (x: number, y: number, z: number, w: number, l: number) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, l), pool);
      m.rotation.x = -Math.PI / 2;
      m.position.set(x, y, z);
      hall.add(m);
    };
    // No cords on these: the end-swap camera flies between them and would clip one.
    const pendant = (x: number, z: number, y: number) => {
      const s = new THREE.Mesh(new THREE.ConeGeometry(0.24, 0.16, 20, 1, true), shade);
      s.position.set(x, y + 0.04, z);
      const b = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), bulb);
      b.position.set(x, y - 0.02, z);
      hall.add(s, b);
    };

    for (const s of [-1, 1]) {
      const x = s * HALL.boards;
      buildShuffleboard(hall, tableMats, x);
      for (const z of [-0.9, -L / 2, -L + 0.9]) {
        pendant(x, z, 1.95);
        lightPool(x, 0.002, z, 1.25, 2.3);
      }
    }

    const felt = new THREE.MeshStandardMaterial({ map: feltTexture(), roughness: 0.95 });
    const cushion = new THREE.MeshStandardMaterial({ color: 0x0c4a2c, roughness: 0.9 });
    const wood = new THREE.MeshStandardMaterial({ color: 0x3b1f10, roughness: 0.5, metalness: 0.1 });
    const pocket = new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 0.9 });
    const cue = new THREE.MeshStandardMaterial({ color: 0xc89a5c, roughness: 0.5 });
    const balls = [0xf5f1e6, 0xf2c200, 0xc4161c, 0x1f3fa8, 0x0a0a0a, 0x7a1f8a, 0xe8650e].map(
      (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.18, metalness: 0.05 }),
    );
    const ballGeo = new THREE.SphereGeometry(0.0285, 14, 10);
    const poolShade = new THREE.MeshStandardMaterial({ color: 0x1d4a34, metalness: 0.4, roughness: 0.5 });
    const PW = 1.27;
    const PL = 2.54;
    const top = FLOOR_Y + 0.79;

    for (const s of [-1, 1]) {
      for (const dz of HALL.poolZ) {
        const x = s * HALL.pool;
        const z = CENTRE.z + dz;
        hall.add(box(PW, 0.04, PL, felt, x, top - 0.02, z));
        for (const k of [-1, 1]) {
          hall.add(box(0.05, 0.045, PL, cushion, x + k * (PW / 2 + 0.025), top + 0.0225, z));
          hall.add(box(PW, 0.045, 0.05, cushion, x, top + 0.0225, z + k * (PL / 2 + 0.025)));
          hall.add(box(0.14, 0.07, PL + 0.38, wood, x + k * (PW / 2 + 0.12), top + 0.015, z));
          hall.add(box(PW + 0.1, 0.07, 0.14, wood, x, top + 0.015, z + k * (PL / 2 + 0.12)));
        }
        hall.add(box(PW + 0.34, 0.26, PL + 0.34, wood, x, top - 0.17, z));
        const legH = top - 0.3 - FLOOR_Y;
        for (const kx of [-1, 1]) {
          for (const kz of [-1, 1]) hall.add(box(0.16, legH, 0.16, wood, x + kx * (PW / 2 - 0.02), FLOOR_Y + legH / 2, z + kz * (PL / 2 - 0.06)));
        }
        for (const kx of [-1, 1]) {
          for (const kz of [-1, 0, 1]) {
            const p = new THREE.Mesh(new THREE.CylinderGeometry(0.062, 0.062, 0.076, 16), pocket);
            p.position.set(x + kx * (PW / 2 + (kz === 0 ? 0.05 : 0.03)), top + 0.013, z + kz * (PL / 2 + 0.03));
            hall.add(p);
          }
        }
        for (let i = 0; i < 9; i++) {
          const b = new THREE.Mesh(ballGeo, balls[i % balls.length]);
          b.position.set(x + (rand() - 0.5) * (PW - 0.2), top + 0.0285, z + (rand() - 0.5) * (PL - 0.25));
          hall.add(b);
        }
        const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.013, 1.45, 10).rotateX(Math.PI / 2), cue);
        stick.position.set(x + (rand() - 0.5) * 0.4, top + 0.014, z + (rand() - 0.5) * 0.6);
        stick.rotation.y = (rand() - 0.5) * 0.9;
        hall.add(stick);

        hall.add(box(0.36, 0.14, 1.5, poolShade, x, top + 0.95, z));
        hall.add(box(0.3, 0.006, 1.42, bulb, x, top + 0.877, z));
        for (const k of [-0.6, 0.6]) {
          const c = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 3), cord);
          c.position.set(x, top + 2.5, z + k);
          hall.add(c);
        }
        lightPool(x, top + 0.003, z, 1.9, 3.1);
      }
    }
    for (const mesh of bake(hall)) this.scene.add(mesh);
  }

  private buildLights(): void {
    this.scene.add(this.hemi);
    const shadeMat = new THREE.MeshStandardMaterial({ color: 0x2c3a34, metalness: 0.6, roughness: 0.45, side: THREE.DoubleSide });
    const bulbMat = new THREE.MeshBasicMaterial({ color: 0xfff1d6 });
    const cordMat = new THREE.MeshBasicMaterial({ color: 0x050505 });
    const lamps = [-0.9, -L / 2, -L + 0.9];
    lamps.forEach((z, i) => {
      const y = 1.95;
      const shade = new THREE.Mesh(new THREE.ConeGeometry(0.24, 0.16, 32, 1, true), shadeMat);
      shade.position.set(0, y + 0.04, z);
      shade.layers.set(LAMP_LAYER);
      this.scene.add(shade);
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.045, 16, 12), bulbMat);
      bulb.position.set(0, y - 0.02, z);
      bulb.layers.set(LAMP_LAYER);
      this.scene.add(bulb);
      const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 3), cordMat);
      cord.position.set(0, y + 1.6, z);
      cord.layers.set(LAMP_LAYER);
      this.scene.add(cord);
      // Both scoring ends get the brighter, shadow-casting lamps.
      const spot = new THREE.SpotLight(0xffe6c4, i === 1 ? 18 : 22, 8, 0.85, 0.65, 1.3);
      spot.position.set(0, y - 0.03, z);
      spot.target.position.set(0, 0, z);
      if (i !== 1) {
        spot.castShadow = true;
        spot.shadow.mapSize.set(1024, 1024);
        spot.shadow.bias = -0.0004;
        spot.shadow.camera.near = 0.5;
        spot.shadow.camera.far = 4.5;
      }
      spot.userData.base = spot.intensity;
      this.spots.push(spot);
      this.scene.add(spot, spot.target);
    });
    const warm = new THREE.PointLight(0xff7a1a, 3, 6, 1.5);
    warm.position.set(-1.6, -0.5, -2);
    const cool = new THREE.PointLight(0x27d3ff, 3, 6, 1.5);
    cool.position.set(1.6, -0.5, -5.2);
    this.scene.add(warm, cool);
  }

  /* ---------- weights and aim ---------- */

  createPuck(team: Team): PuckView {
    const group = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(R, R * 0.98, H, 40), this.chrome);
    body.position.y = H / 2;
    body.castShadow = true;
    const cap = new THREE.MeshStandardMaterial({
      color: TEAM_COLORS[team],
      emissive: TEAM_COLORS[team],
      emissiveIntensity: 0.25,
      roughness: 0.35,
      metalness: 0.1,
    });
    const top = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.74, R * 0.74, 0.004, 32), cap);
    top.position.y = H + 0.001;
    const dot = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.22, R * 0.22, 0.005, 20), this.chrome);
    dot.position.y = H + 0.002;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(R * 1.15, R * 1.45, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false }),
    );
    ring.position.y = 0.002;
    ring.visible = false;
    group.add(body, top, dot, ring);
    this.play.add(group);
    return { group, cap, ring };
  }

  highlight(p: PuckView, team: Team): void {
    p.ring.visible = true;
    (p.ring.material as THREE.MeshBasicMaterial).color.set(TEAM_COLORS[team]);
  }

  removePuck(p: PuckView): void {
    this.play.remove(p.group);
  }

  showAim(x: number, d: number, angle: number, power: number, team: Team): void {
    this.aim.visible = true;
    this.aim.position.set(x, 0.003, -d);
    this.aim.rotation.y = -angle;
    this.aim.scale.set(1, 1, 0.35 + power * 2.6);
    (this.aim.material as THREE.MeshBasicMaterial).color.set(TEAM_COLORS[team]);
  }

  hideAim(): void {
    this.aim.visible = false;
  }

  /* ---------- ends and camera ---------- */

  get end(): End {
    return this.endNow;
  }

  /** True while the end-swap fly-around is playing. */
  get swapping(): boolean {
    return this.rig.swapping;
  }

  /**
   * Turn play round to shoot from `end`. With `animate`, the camera flies out
   * over the hall and lands behind the new end; otherwise it just eases over.
   */
  setEnd(end: End, animate = false): void {
    if (end === this.endNow) return;
    this.endNow = end;
    this.play.rotation.y = end === 1 ? Math.PI : 0;
    this.play.position.z = end === 1 ? -L : 0;
    this.aimHeadCam();
    this.rig.setEnd(end, animate);
  }

  private aimHeadCam(): void {
    const z = this.worldZ(-(L - 1.6));
    this.headCam.up.set(0, 0, this.endNow === 1 ? 1 : -1);
    this.headCam.position.set(0, 4, z);
    this.headCam.lookAt(0, 0, z);
  }

  /** Shooter-relative scene z (-d) → world z. */
  private worldZ(z: number): number {
    return this.endNow === 1 ? -L - z : z;
  }

  setCamera(mode: CameraMode, followD?: number): void {
    this.rig.setMode(mode, followD);
  }

  snapCamera(): void {
    this.rig.snap();
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.fov = w / h < 0.8 ? 58 : 44;
    this.camera.updateProjectionMatrix();
    this.rig.portrait = w / h < 0.8;
  }

  /** Screen position of a shooter-relative point. */
  toScreen(x: number, y: number, d: number): { x: number; y: number } {
    toWorld(this.endNow, this.tmp.set(x, y, -d)).project(this.camera);
    return { x: ((this.tmp.x + 1) / 2) * window.innerWidth, y: ((1 - this.tmp.y) / 2) * window.innerHeight };
  }

  /** Ray from a screen point onto the table plane, in shooter-relative coordinates. */
  pickTable(sx: number, sy: number): { x: number; d: number } | null {
    const ndc = new THREE.Vector2((sx / window.innerWidth) * 2 - 1, -(sy / window.innerHeight) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hit = new THREE.Vector3();
    if (!ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit)) return null;
    return this.endNow === 1 ? { x: -hit.x, d: L + hit.z } : { x: hit.x, d: -hit.z };
  }

  render(dt: number): void {
    this.time += dt;
    const rig = this.rig;
    rig.update(dt);
    this.camera.position.set(rig.pos.x, rig.pos.y, rig.pos.z);
    this.camera.lookAt(rig.look.x, rig.look.y, rig.look.z);
    // RoomEnvironment is lopsided (its biggest softbox is on +z), so the reflections turn with the end;
    // otherwise end 1 looks straight into that softbox's glare on the clear coat.
    this.scene.environmentRotation.y = rig.envYaw.value;

    const hemi = HEMI + SWAP.houseLights * rig.reveal;
    this.hemi.intensity = hemi;
    this.fog.near = FOG_NEAR + SWAP.fogPush * rig.reveal;
    this.fog.far = FOG_FAR + SWAP.fogPush * 1.4 * rig.reveal;

    const flicker = 0.92 + 0.08 * Math.sin(this.time * 2.3) * Math.sin(this.time * 7.1);
    this.neon.forEach((m) => (m.opacity = flicker));

    const r = this.renderer;
    const w = window.innerWidth;
    const h = window.innerHeight;
    r.shadowMap.needsUpdate = true;
    r.setScissorTest(false);
    r.setViewport(0, 0, w, h);
    r.render(this.scene, this.camera);

    if (this.inset && rig.mode !== "head" && !rig.swapping) {
      const { x, y, w: iw, h: ih } = this.inset;
      const halfH = 1.6;
      const halfW = (halfH * iw) / ih;
      this.headCam.left = -halfW;
      this.headCam.right = halfW;
      this.headCam.top = halfH;
      this.headCam.bottom = -halfH;
      this.headCam.position.z = this.worldZ(-(L + 0.05 - halfH));
      this.headCam.updateProjectionMatrix();
      this.scene.fog = null;
      // Straight-down view under straight-down lamps is all clearcoat glare, so light it flat.
      this.spots.forEach((s) => (s.intensity = 0));
      this.hemi.intensity = 2.4;
      this.scene.environmentIntensity = 0.04;
      r.toneMappingExposure = 0.85;
      r.setScissorTest(true);
      r.setScissor(x, h - y - ih, iw, ih);
      r.setViewport(x, h - y - ih, iw, ih);
      r.render(this.scene, this.headCam);
      this.scene.fog = this.fog;
      r.toneMappingExposure = EXPOSURE;
      this.spots.forEach((s) => (s.intensity = s.userData.base));
      this.hemi.intensity = hemi;
      this.scene.environmentIntensity = ENV_INTENSITY;
      r.setScissorTest(false);
    }
  }
}
