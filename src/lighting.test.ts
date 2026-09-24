import assert from "node:assert/strict";
import { test } from "node:test";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { TABLE, type End } from "./rules.ts";
import { CameraRig, toWorld, type CameraMode } from "./rig.ts";

/**
 * The clear-coated table mirrors the environment map. RoomEnvironment's
 * softboxes are lopsided (the biggest, intensity 43 and ~24 m², is on +z), and
 * end 1's cameras look along +z. Trace the mirror reflection of every point of
 * the scoring zones back into the room and add up the softbox light it picks up.
 */
function zoneGlare(end: End, envYaw: number, mode: CameraMode, portrait: boolean): number {
  const lights = new RoomEnvironment().children
    .filter((o): o is THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial> => o instanceof THREE.Mesh && (o.material as THREE.MeshLambertMaterial).emissiveIntensity > 1)
    .map((m) => ({ box: new THREE.Box3().setFromCenterAndSize(m.position, m.scale), power: m.material.emissiveIntensity }));
  const rig = new CameraRig();
  rig.portrait = portrait;
  rig.setEnd(end);
  // Follow with the weight arriving in the zones.
  rig.setMode(mode, 5.2);
  for (let i = 0; i < 300; i++) rig.update(1 / 60);
  rig.snap();
  const cam = new THREE.Vector3(rig.pos.x, rig.pos.y, rig.pos.z);
  const up = new THREE.Vector3(0, 1, 0);
  const ray = new THREE.Ray();
  const hit = new THREE.Vector3();
  let sum = 0;
  let n = 0;
  for (let d = TABLE.foul; d <= TABLE.length; d += 0.05) {
    for (let x = -0.4; x <= 0.4; x += 0.05) {
      const dir = toWorld(end, new THREE.Vector3(x, 0, -d)).sub(cam).normalize();
      dir.y = -dir.y;
      // The environment turned by `envYaw` is the same as the lookup turned back.
      ray.set(new THREE.Vector3(), dir.applyAxisAngle(up, -envYaw));
      let nearest = Infinity;
      let power = 0;
      for (const l of lights) {
        if (ray.intersectBox(l.box, hit) && hit.length() < nearest) {
          nearest = hit.length();
          power = l.power;
        }
      }
      sum += power;
      n++;
    }
  }
  return sum / n;
}

test("end 2 wash-out: the room's softbox glares over the zones unless reflections turn with the end", () => {
  const rig = new CameraRig();
  rig.setEnd(1);
  for (let t = 0; t < 3; t += 1 / 60) rig.update(1 / 60);
  const yaw1 = rig.envYaw.value;
  assert.ok(Math.abs(yaw1 - Math.PI) < 1e-3, "the rig turns the reflections half round for end 1");

  for (const mode of ["follow", "head", "aim"] as const) {
    for (const portrait of [true, false]) {
      const at = `${mode} ${portrait ? "portrait" : "landscape"}`;
      const end0 = zoneGlare(0, 0, mode, portrait);
      const end1Fixed = zoneGlare(1, yaw1, mode, portrait);
      assert.ok(end0 < 1, `${at}: end 0's zones stay clear of the softboxes (${end0.toFixed(2)})`);
      assert.ok(Math.abs(end1Fixed - end0) < 1e-6, `${at}: end 1 now reflects exactly what end 0 does (${end1Fixed.toFixed(2)} vs ${end0.toFixed(2)})`);
    }
  }
  // What used to happen: following a weight into end 1's zones looked straight into the big +z softbox.
  assert.ok(zoneGlare(1, 0, "follow", true) > 5, "without the turn, end 1's zones mirror the softbox");
});
