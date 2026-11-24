/**
 * Copyright 2026 Robotic Crew
 *
 *    Licensed under the Apache License, Version 2.0 (the "License");
 *    you may not use this file except in compliance with the License.
 *    You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *    Unless required by applicable law or agreed to in writing, software
 *    distributed under the License is distributed on an "AS IS" BASIS,
 *    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *    See the License for the specific language governing permissions and
 *    limitations under the License.
 */

/**
 * The cell around the robot, from a `scenes` document (see docs/intrinsic-core-widgets.md):
 * objects as primitives, frames as axes, objects attached to robot links (e.g. the piece in the
 * gripper), and the planned tool path. Poses are in the robot's base frame, so the result goes in
 * the same (Z-up) group as the robot.
 *
 * The cell is updated in place: object meshes are kept by id and only rebuilt when their shape,
 * size or color change; frames and the planned path are rebuilt only when they change.
 */
import {
  AxesHelper, BoxGeometry, BufferGeometry, CylinderGeometry, Group, Line, LineBasicMaterial, Mesh,
  MeshStandardMaterial, SphereGeometry, Vector3,
} from 'three';

const DEFAULT_COLOR = '#9a9da3';
const FRAME_SIZE = 0.06;

const geometryFor = ({ shape, size = [] }) => {
  switch (shape) {
    case 'cylinder': {
      // three.js cylinders run along Y, scene cylinders along Z
      const geometry = new CylinderGeometry(size[0] || 0.05, size[0] || 0.05, size[1] || 0.1, 32);
      geometry.rotateX(Math.PI / 2);
      return geometry;
    }
    case 'sphere':
      return new SphereGeometry(size[0] || 0.05, 24, 16);
    default:
      return new BoxGeometry(size[0] || 0.1, size[1] || 0.1, size[2] || 0.1);
  }
};

const applyPose = (object, pose) => {
  if (pose) {
    object.position.fromArray(pose.position);
    object.quaternion.fromArray(pose.quaternion);
  }
};

/** The robot link named `name`, if the robot has one (never an inherited property). */
const linkOf = (robot, name) => {
  const links = robot?.links;
  if (!links || typeof name !== 'string' || !Object.hasOwn(links, name)) {
    return null;
  }
  const link = links[name];
  return link?.isObject3D ? link : null;
};

const disposeTree = (root) => root.traverse((obj) => {
  obj.geometry?.dispose();
  obj.material?.dispose();
});

/**
 * The cell around one robot (an URDFRobot, to find attachment links). Add `group` next to the
 * robot, call `update()` with each new scene document, and `dispose()` to remove everything
 * (also what was attached to robot links) and free GPU memory.
 */
class CellScene {
  constructor() {
    this.group = new Group();
    // id -> { mesh, key }
    this._objects = new Map();
    this._frames = null;
    this._framesKey = null;
    this._path = null;
    this._pathKey = null;
  }

  /** `layers` selects { scene, frames, path }. */
  update(sceneDoc, robot, layers, pathColor) {
    this._updateObjects(layers.scene ? sceneDoc.objects || [] : [], sceneDoc.attached || [], robot);
    this._updateFrames(layers.frames ? sceneDoc.frames || [] : []);
    this._updatePath(layers.path ? sceneDoc.plannedPath || [] : [], pathColor);
  }

  _updateObjects(objects, attached, robot) {
    const attachments = new Map(attached.map(a => [a.objectId, a]));
    const seen = new Set();
    objects.forEach((object, ix) => {
      // Ids should be unique; a repeated one still gets its own mesh
      const id = seen.has(object.id) ? `${object.id}#${ix}` : object.id;
      seen.add(id);
      const key = JSON.stringify([object.shape, object.size, object.color]);
      let entry = this._objects.get(id);
      if (entry && entry.key !== key) {
        entry.mesh.removeFromParent();
        disposeTree(entry.mesh);
        entry = null;
      }
      if (!entry) {
        const mesh = new Mesh(
          geometryFor(object),
          new MeshStandardMaterial({ color: object.color || DEFAULT_COLOR, roughness: 0.8, metalness: 0.1 }),
        );
        entry = { mesh, key };
        this._objects.set(id, entry);
      }
      const { mesh } = entry;
      mesh.name = object.name;
      const attachment = attachments.get(object.id);
      const link = attachment ? linkOf(robot, attachment.link) : null;
      const parent = link || this.group;
      if (mesh.parent !== parent) {
        parent.add(mesh);
      }
      applyPose(mesh, link ? attachment.pose : object.pose);
    });
    this._objects.forEach(({ mesh }, id) => {
      if (!seen.has(id)) {
        mesh.removeFromParent();
        disposeTree(mesh);
        this._objects.delete(id);
      }
    });
  }

  _updateFrames(frames) {
    const key = JSON.stringify(frames);
    if (key === this._framesKey) {
      return;
    }
    this._framesKey = key;
    if (this._frames) {
      this._frames.removeFromParent();
      disposeTree(this._frames);
    }
    this._frames = new Group();
    frames.forEach((frame) => {
      const axes = new AxesHelper(FRAME_SIZE);
      axes.name = frame.name;
      applyPose(axes, frame.pose);
      this._frames.add(axes);
    });
    this.group.add(this._frames);
  }

  _updatePath(path, color) {
    const points = path.length > 1 ? path : [];
    const key = JSON.stringify([points, color]);
    if (key === this._pathKey) {
      return;
    }
    this._pathKey = key;
    if (this._path) {
      this._path.removeFromParent();
      disposeTree(this._path);
      this._path = null;
    }
    if (points.length) {
      const geometry = new BufferGeometry().setFromPoints(points.map(p => new Vector3(...p)));
      this._path = new Line(geometry, new LineBasicMaterial({ color }));
      this.group.add(this._path);
    }
  }

  dispose() {
    this._objects.forEach(({ mesh }) => {
      mesh.removeFromParent();
      disposeTree(mesh);
    });
    this._objects.clear();
    disposeTree(this.group);
    this.group.removeFromParent();
  }
}

export default CellScene;
