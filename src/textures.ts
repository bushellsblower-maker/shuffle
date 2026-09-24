import * as THREE from "three";
import { TABLE } from "./rules.ts";
import { SURFACE } from "./surface.ts";

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Maple planks with the zone tints at both ends, plus a dusting of sand that is
 * heaviest down the middle of the lane. The lines and numbers are a separate
 * matte decal (`markingsTexture`) so the clear coat's reflections can't wash
 * them out. Canvas y=0 is the far end (d = length, as seen from end 0).
 */
export function tableTexture(maxAnisotropy: number): THREE.CanvasTexture {
  const W = 512;
  const H = 4096;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  const rand = rng(7);
  const toY = (d: number) => ((TABLE.length - d) / TABLE.length) * H;

  const span = (r: readonly [number, number]) => r[0] + rand() * (r[1] - r[0]);
  const planks = 8;
  for (let p = 0; p < planks; p++) {
    const x0 = (p * W) / planks;
    const hue = span(SURFACE.woodHue);
    const light = span(SURFACE.woodLightness);
    g.fillStyle = `hsl(${hue} ${SURFACE.woodSaturation}% ${light}%)`;
    g.fillRect(x0, 0, W / planks, H);
    for (let i = 0; i < 70; i++) {
      const gx = x0 + rand() * (W / planks);
      g.strokeStyle = `hsla(${hue - 6} 45% ${light - SURFACE.grainDarken}% / ${0.05 + rand() * 0.12})`;
      g.lineWidth = 0.6 + rand() * 1.6;
      g.beginPath();
      g.moveTo(gx, 0);
      for (let y = 0; y <= H; y += 128) g.lineTo(gx + Math.sin(y * 0.004 + i) * 3 * rand(), y);
      g.stroke();
    }
    g.fillStyle = "rgba(60,35,10,0.35)";
    g.fillRect(x0, 0, 1.5, H);
  }

  g.save();
  g.translate(W / 2, toY(TABLE.length / 2));
  g.rotate(-Math.PI / 2);
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.font = `900 150px "Arial Black", Impact, sans-serif`;
  g.fillStyle = "rgba(60,30,8,0.12)";
  g.fillText("SHUFFLE", 0, 0);
  g.restore();

  const ends = [TABLE.zones[1], TABLE.zones[2], TABLE.zones[3], TABLE.length];
  for (const mirror of [false, true]) {
    const py = (d: number) => toY(mirror ? TABLE.length - d : d);
    const tints = ["rgba(255,122,26,0.10)", "rgba(255,194,26,0.13)", "rgba(255,122,26,0.17)", "rgba(230,40,40,0.2)"];
    TABLE.zones.forEach((start, i) => {
      g.fillStyle = tints[i];
      const a = py(ends[i]);
      const b = py(start);
      g.fillRect(0, Math.min(a, b), W, Math.abs(b - a));
    });
  }

  // Sand dust: fine pale specks, heaviest down the middle of the lane.
  const dust = ["rgb(255,248,230)", "rgb(200,180,140)"];
  for (let i = 0; i < SURFACE.dustSpecks; i++) {
    const across = Math.max(-1, Math.min(1, (rand() + rand() + rand() - 1.5) * 0.9));
    const x = W / 2 + across * (W / 2);
    const y = rand() * H;
    g.globalAlpha = span(SURFACE.dustAlpha);
    g.fillStyle = dust[rand() < 0.7 ? 0 : 1];
    const s = rand() < SURFACE.dustCoarse ? 2 : 1;
    g.fillRect(x, y, s, s);
  }
  g.globalAlpha = 1;

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAnisotropy;
  return tex;
}

/**
 * Zone lines, foul line, zone numbers, and the launch line for both ends, on
 * a transparent canvas laid over the table as a matte decal. Same layout as
 * `tableTexture` (y=0 is the far end); end 1's art is end 0's turned half round.
 */
export function markingsTexture(maxAnisotropy: number): THREE.CanvasTexture {
  const W = 256;
  const H = 2048;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  const px = H / TABLE.length;
  const toY = (d: number) => (TABLE.length - d) * px;
  const ends = [TABLE.zones[1], TABLE.zones[2], TABLE.zones[3], TABLE.length];
  const { ink, red } = SURFACE;

  for (const mirror of [false, true]) {
    const py = (d: number) => toY(mirror ? TABLE.length - d : d);
    const flip = mirror ? -1 : 1;
    // Widths in metres, so they stay put if the canvas size changes.
    const band = (d: number, width: number) => g.fillRect(0, py(d) - (width * px) / 2, W, width * px);

    g.fillStyle = ink;
    TABLE.zones.slice(1).forEach((z) => band(z, 0.02));

    g.fillStyle = red;
    band(TABLE.foul, 0.032);
    g.fillStyle = "#fff4e8";
    for (let x = 0; x < W; x += 24) g.fillRect(x, py(TABLE.foul) - 1, 12, 2);

    g.textAlign = "center";
    g.textBaseline = "middle";
    const numbers = ["1", "2", "3", "4"];
    TABLE.zones.forEach((start, i) => {
      g.save();
      g.translate(W / 2, py((start + ends[i]) / 2));
      if (mirror) g.rotate(Math.PI);
      g.scale(1, 2.6);
      g.font = `900 ${i === 3 ? 30 : 50}px "Arial Black", Impact, sans-serif`;
      g.fillStyle = ink;
      g.fillText(numbers[i], 0, 0);
      g.restore();
    });

    g.save();
    g.translate(W / 2, py(TABLE.foul) + 30 * flip);
    if (mirror) g.rotate(Math.PI);
    g.font = `900 17px "Arial Black", Impact, sans-serif`;
    g.fillStyle = red;
    g.fillText("FOUL LINE", 0, 0);
    g.restore();

    g.fillStyle = "rgba(22,22,26,0.7)";
    band(TABLE.launchD + TABLE.puckRadius + 0.1, 0.01);
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAnisotropy;
  return tex;
}

export function concreteTexture(): THREE.CanvasTexture {
  const S = 512;
  const c = document.createElement("canvas");
  c.width = S;
  c.height = S;
  const g = c.getContext("2d")!;
  const rand = rng(3);
  g.fillStyle = "#34363a";
  g.fillRect(0, 0, S, S);
  for (let i = 0; i < 9000; i++) {
    const v = 30 + rand() * 40;
    g.fillStyle = `rgba(${v},${v + 2},${v + 5},${0.25 + rand() * 0.3})`;
    g.fillRect(rand() * S, rand() * S, 1 + rand() * 3, 1 + rand() * 3);
  }
  g.strokeStyle = "rgba(0,0,0,0.5)";
  g.lineWidth = 3;
  g.strokeRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(8, 8);
  return tex;
}

/** Neon wall sign text: lines are shrunk to fit the canvas width so long copy stays legible. */
export function neonTexture(lines: readonly string[], glow: string, fill: string): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 1024;
  c.height = 512;
  const g = c.getContext("2d")!;
  g.textAlign = "center";
  g.textBaseline = "middle";
  const pad = 70;
  const rowH = (c.height - pad) / lines.length;
  lines.forEach((text, i) => {
    let size = Math.min(170, rowH * 0.8);
    g.font = `900 ${size}px "Arial Black", Impact, sans-serif`;
    const width = g.measureText(text).width;
    if (width > c.width - pad * 2) size *= (c.width - pad * 2) / width;
    g.font = `900 ${Math.floor(size)}px "Arial Black", Impact, sans-serif`;
    const y = pad / 2 + rowH * (i + 0.5);
    g.shadowColor = glow;
    g.shadowBlur = 36;
    g.fillStyle = fill;
    g.fillText(text, c.width / 2, y);
    g.fillText(text, c.width / 2, y);
  });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Radial falloff used to fake the pool of light under each hall lamp. */
export function glowTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.45, "rgba(255,255,255,0.45)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Pool-table baize: green with a faint nap. */
export function feltTexture(): THREE.CanvasTexture {
  const S = 256;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d")!;
  const rand = rng(11);
  g.fillStyle = "#11613a";
  g.fillRect(0, 0, S, S);
  for (let i = 0; i < 5000; i++) {
    const v = rand();
    g.fillStyle = v < 0.5 ? `rgba(0,30,12,${0.08 + rand() * 0.1})` : `rgba(80,170,110,${0.05 + rand() * 0.08})`;
    g.fillRect(rand() * S, rand() * S, 1 + rand() * 2, 1);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 2);
  return tex;
}

/** Soft arrow strip used as the aim guide; drawn pointing toward canvas top. */
export function aimTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 512;
  const g = c.getContext("2d")!;
  for (let y = 40; y < 512; y += 36) {
    const a = 0.25 + 0.75 * (1 - y / 512);
    g.fillStyle = `rgba(255,255,255,${a})`;
    g.beginPath();
    g.moveTo(32, y);
    g.lineTo(54, y + 18);
    g.lineTo(32, y + 10);
    g.lineTo(10, y + 18);
    g.closePath();
    g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
