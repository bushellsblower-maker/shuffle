import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { TABLE, type Team } from "./rules.ts";
import { smoothDamp, smoothMin, type Spring } from "./smooth.ts";
import { aimTexture, concreteTexture, tableTexture } from "./textures.ts";

export const TEAM_COLORS = ["#ff7a1a", "#27d3ff"] as const;

const W = TABLE.width;
const L = TABLE.length;
const R = TABLE.puckRadius;
const H = TABLE.puckHeight;
export const GUTTER_W = 0.13;
export const GUTTER_Y = -0.075;
export const PIT_LEN = 0.2;
const RAIL_W = 0.05;
const FLOOR_Y = -0.92;
/** Lamp fixtures render in the main view only, never in the top-down head cam. */
const LAMP_LAYER = 1;
/** Follow-cam spring time (s). Paired with the look-ahead in main.ts, which cancels most of its lag. */
export const FOLLOW_SMOOTH = 0.26;

export type CameraMode = "aim" | "follow" | "head" | "overview";

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

function box(w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = false;
  m.receiveShadow = true;
  return m;
}

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(50, 1, 0.05, 60);
  readonly headCam = new THREE.OrthographicCamera(-0.62, 0.62, 1.6, -1.6, 0.1, 10);
  readonly table = new THREE.Group();
  readonly aim: THREE.Mesh;
  inset: Rect | null = null;

  private mode: CameraMode = "overview";
  /** Follow cam: where the caller wants to look (`focusTarget`), and the spring-smoothed value used. */
  private focusTarget: number = TABLE.launchD;
  private focus: Spring = { value: TABLE.launchD, vel: 0 };
  private camPos = new THREE.Vector3(0, 3, 4);
  private camLook = new THREE.Vector3(0, 0, -3);
  private wantPos = new THREE.Vector3();
  private wantLook = new THREE.Vector3();
  /**
   * Mode changes ease out an offset from the new shot instead of lerping toward
   * a moving target, so the follow cam tracks with no lag once blended in.
   */
  private posOff = new THREE.Vector3();
  private lookOff = new THREE.Vector3();
  private blendRate = 3;
  private time = 0;
  private neon: THREE.MeshBasicMaterial[] = [];
  private tmp = new THREE.Vector3();
  private chrome: THREE.MeshStandardMaterial;
  private spots: THREE.SpotLight[] = [];
  private hemi = new THREE.HemisphereLight(0x8090a0, 0x201810, 0.35);

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = false;

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.35;
    this.scene.background = new THREE.Color(0x0a0b0e);
    this.scene.fog = new THREE.Fog(0x0a0b0e, 7, 18);

    this.chrome = new THREE.MeshStandardMaterial({ color: 0xd9dee4, metalness: 1, roughness: 0.26 });

    this.camera.layers.enable(LAMP_LAYER);
    this.headCam.position.set(0, 4, -5.9);
    this.headCam.up.set(0, 0, -1);
    this.headCam.lookAt(0, 0, -5.9);

    this.buildTable();
    this.buildRoom();
    this.buildLights();

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
    this.scene.add(this.aim);
  }

  private buildTable(): void {
    const t = this.table;
    this.scene.add(t);
    const surfaceMat = new THREE.MeshPhysicalMaterial({
      map: tableTexture(this.renderer.capabilities.getMaxAnisotropy()),
      roughness: 0.32,
      clearcoat: 1,
      clearcoatRoughness: 0.12,
    });
    const surface = new THREE.Mesh(new THREE.PlaneGeometry(W, L), surfaceMat);
    surface.rotation.x = -Math.PI / 2;
    surface.position.set(0, 0, -L / 2);
    surface.receiveShadow = true;
    t.add(surface);

    const edgeWood = new THREE.MeshStandardMaterial({ color: 0x5a3a1c, roughness: 0.55 });
    const steel = new THREE.MeshStandardMaterial({ color: 0x3a3f45, metalness: 0.85, roughness: 0.45 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.7, metalness: 0.2 });
    const rubber = new THREE.MeshStandardMaterial({ color: 0x1b1b1d, roughness: 0.95 });

    t.add(box(W, 0.08, L, edgeWood, 0, -0.041, -L / 2));
    const outerX = W / 2 + GUTTER_W + RAIL_W / 2;
    const fullW = W + 2 * (GUTTER_W + RAIL_W);
    const zFar = -(L + PIT_LEN);
    const zNear = 0.24;
    const bodyLen = zNear - zFar;
    const bodyMid = (zNear + zFar) / 2;

    for (const s of [-1, 1]) {
      t.add(box(GUTTER_W, 0.01, bodyLen, steel, s * (W / 2 + GUTTER_W / 2), GUTTER_Y - 0.005, bodyMid));
      t.add(box(RAIL_W, 0.13, bodyLen, dark, s * outerX, -0.03, bodyMid));
      const strip = new THREE.MeshBasicMaterial({ color: s < 0 ? TEAM_COLORS[0] : TEAM_COLORS[1] });
      t.add(box(0.012, 0.012, bodyLen, strip, s * (W / 2 + GUTTER_W + 0.006), 0.036, bodyMid));
      t.add(box(0.01, 0.02, bodyLen, strip, s * (outerX + RAIL_W / 2 + 0.005), -0.22, bodyMid));
    }

    t.add(box(fullW, 0.01, PIT_LEN, steel, 0, GUTTER_Y - 0.005, -(L + PIT_LEN / 2)));
    t.add(box(fullW, 0.2, 0.06, dark, 0, 0.01, zFar - 0.03));
    t.add(box(fullW - 0.02, 0.1, 0.03, rubber, 0, 0.0, zFar + 0.012));
    const zStrip = new THREE.MeshBasicMaterial({ color: 0xffc21a });
    t.add(box(fullW, 0.014, 0.014, zStrip, 0, 0.115, zFar - 0.03));

    t.add(box(fullW, 0.01, zNear, steel, 0, -0.035, zNear / 2));
    t.add(box(fullW, 0.12, 0.05, dark, 0, -0.02, zNear + 0.025));

    const apron = new THREE.MeshStandardMaterial({ color: 0x1d2024, roughness: 0.6, metalness: 0.4 });
    t.add(box(fullW, 0.2, bodyLen + 0.05, apron, 0, -0.19, bodyMid));
    const legMat = new THREE.MeshStandardMaterial({ color: 0x24272b, metalness: 0.7, roughness: 0.4 });
    for (const z of [0.05, -L / 2, -L]) {
      for (const s of [-1, 1]) t.add(box(0.1, -FLOOR_Y - 0.28, 0.1, legMat, s * (fullW / 2 - 0.08), (FLOOR_Y - 0.28) / 2, z));
    }
    t.traverse((o) => {
      if (o instanceof THREE.Mesh) o.receiveShadow = true;
    });
  }

  private buildRoom(): void {
    const floorTex = concreteTexture();
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(30, 30),
      new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.92, metalness: 0.05 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, FLOOR_Y, -4);
    floor.receiveShadow = true;
    this.scene.add(floor);

    const wall = new THREE.Mesh(
      new THREE.PlaneGeometry(14, 6),
      new THREE.MeshStandardMaterial({ color: 0x1a1c20, roughness: 0.9 }),
    );
    wall.position.set(0, 2, -L - 2.2);
    this.scene.add(wall);

    const c = document.createElement("canvas");
    c.width = 1024;
    c.height = 256;
    const g = c.getContext("2d")!;
    g.font = `900 150px "Arial Black", Impact, sans-serif`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.shadowColor = "#ff7a1a";
    g.shadowBlur = 40;
    g.fillStyle = "#ffd6b0";
    g.fillText("SHUFFLE", 512, 128);
    g.fillText("SHUFFLE", 512, 128);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const signMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    this.neon.push(signMat);
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 0.6), signMat);
    sign.position.set(0, 1.25, -L - 2.15);
    this.scene.add(sign);

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
    stripeTex.repeat.set(12, 1);
    const hazard = new THREE.Mesh(new THREE.PlaneGeometry(14, 0.25), new THREE.MeshStandardMaterial({ map: stripeTex, roughness: 0.8 }));
    hazard.position.set(0, FLOOR_Y + 0.4, -L - 2.19);
    this.scene.add(hazard);
  }

  private buildLights(): void {
    this.scene.add(this.hemi);
    const shadeMat = new THREE.MeshStandardMaterial({ color: 0x2c3a34, metalness: 0.6, roughness: 0.45, side: THREE.DoubleSide });
    const bulbMat = new THREE.MeshBasicMaterial({ color: 0xfff1d6 });
    const cordMat = new THREE.MeshBasicMaterial({ color: 0x050505 });
    const lamps = [-0.9, -3.4, -6.2];
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
      const spot = new THREE.SpotLight(0xffe6c4, i === 2 ? 24 : 18, 8, 0.85, 0.65, 1.3);
      spot.position.set(0, y - 0.03, z);
      spot.target.position.set(0, 0, z - 0.1);
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
    cool.position.set(1.6, -0.5, -5);
    this.scene.add(warm, cool);
  }

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
    this.scene.add(group);
    return { group, cap, ring };
  }

  highlight(p: PuckView, team: Team): void {
    p.ring.visible = true;
    (p.ring.material as THREE.MeshBasicMaterial).color.set(TEAM_COLORS[team]);
  }

  removePuck(p: PuckView): void {
    this.scene.remove(p.group);
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

  setCamera(mode: CameraMode, followD?: number): void {
    if (followD !== undefined) this.focusTarget = followD;
    if (mode === this.mode) return;
    if (mode === "follow") this.focus = { value: this.focusTarget, vel: 0 };
    this.mode = mode;
    this.computeWanted();
    this.posOff.subVectors(this.camPos, this.wantPos);
    this.lookOff.subVectors(this.camLook, this.wantLook);
    this.blendRate = mode === "follow" ? 6 : 3;
  }

  snapCamera(): void {
    this.computeWanted();
    this.camPos.copy(this.wantPos);
    this.camLook.copy(this.wantLook);
    this.posOff.set(0, 0, 0);
    this.lookOff.set(0, 0, 0);
  }

  private computeWanted(): void {
    const portrait = this.camera.aspect < 0.8;
    switch (this.mode) {
      case "aim":
        if (portrait) {
          this.wantPos.set(0, 1.3, 1.55);
          this.wantLook.set(0, 0, -2.9);
        } else {
          this.wantPos.set(0, 1.25, 1.8);
          this.wantLook.set(0, 0, -3.1);
        }
        break;
      case "follow": {
        // Soft limits: a hard min() makes the camera stop dead and kinks its pitch near the far end.
        const d = smoothMin(this.focus.value, L - 1.2, 0.3);
        this.wantPos.set(0, portrait ? 1.15 : 0.85, -d + (portrait ? 2.1 : 1.8));
        this.wantLook.set(0, 0, -smoothMin(d + 2.6, L, 0.35));
        break;
      }
      case "head":
        this.wantPos.set(0, portrait ? 1.9 : 1.3, -L + 2.0);
        this.wantLook.set(0, 0, -L + (portrait ? 1.0 : 0.95));
        break;
      case "overview":
        this.wantPos.set(Math.sin(this.time * 0.15) * 1.6, 2.2, 1.2 + Math.cos(this.time * 0.15) * 0.8);
        this.wantLook.set(0, 0, -4.2);
        break;
    }
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.fov = w / h < 0.8 ? 58 : 44;
    this.camera.updateProjectionMatrix();
  }

  toScreen(x: number, y: number, d: number): { x: number; y: number } {
    this.tmp.set(x, y, -d).project(this.camera);
    return { x: ((this.tmp.x + 1) / 2) * window.innerWidth, y: ((1 - this.tmp.y) / 2) * window.innerHeight };
  }

  /** Ray from a screen point onto the table plane, in table coordinates. */
  pickTable(sx: number, sy: number): { x: number; d: number } | null {
    const ndc = new THREE.Vector2((sx / window.innerWidth) * 2 - 1, -(sy / window.innerHeight) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hit = new THREE.Vector3();
    if (!ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit)) return null;
    return { x: hit.x, d: -hit.z };
  }

  render(dt: number): void {
    this.time += dt;
    if (this.mode === "follow") smoothDamp(this.focus, this.focusTarget, FOLLOW_SMOOTH, dt);
    this.computeWanted();
    const keep = Math.exp(-dt * this.blendRate);
    this.posOff.multiplyScalar(keep);
    this.lookOff.multiplyScalar(keep);
    this.camPos.addVectors(this.wantPos, this.posOff);
    this.camLook.addVectors(this.wantLook, this.lookOff);
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);

    const flicker = 0.92 + 0.08 * Math.sin(this.time * 2.3) * Math.sin(this.time * 7.1);
    this.neon.forEach((m) => (m.opacity = flicker));

    const r = this.renderer;
    const w = window.innerWidth;
    const h = window.innerHeight;
    r.shadowMap.needsUpdate = true;
    r.setScissorTest(false);
    r.setViewport(0, 0, w, h);
    r.render(this.scene, this.camera);

    if (this.inset && this.mode !== "head") {
      const { x, y, w: iw, h: ih } = this.inset;
      const halfH = 1.6;
      const halfW = (halfH * iw) / ih;
      this.headCam.left = -halfW;
      this.headCam.right = halfW;
      this.headCam.top = halfH;
      this.headCam.bottom = -halfH;
      this.headCam.position.z = -(L + 0.05 - halfH);
      this.headCam.updateProjectionMatrix();
      const fog = this.scene.fog;
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
      this.scene.fog = fog;
      r.toneMappingExposure = 1.05;
      this.spots.forEach((s) => (s.intensity = s.userData.base));
      this.hemi.intensity = 0.35;
      this.scene.environmentIntensity = 0.35;
      r.setScissorTest(false);
    }
  }
}
