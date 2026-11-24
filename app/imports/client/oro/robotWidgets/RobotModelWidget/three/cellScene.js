/**
 * Copyright 2026 InOrbit, Inc.
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

/**
 * Builds the scene's objects for `robot` (an URDFRobot, to find attachment links). `layers`
 * selects { scene, frames, path }. Returns { group, dispose }: add `group` next to the robot;
 * `dispose()` removes everything (also what was attached to robot links) and frees GPU memory.
 */
const buildCellScene = (sceneDoc, robot, layers, pathColor) => {
  const group = new Group();
  const attachedToLinks = [];
  const attachments = Object.fromEntries((sceneDoc.attached || []).map(a => [a.objectId, a]));

  if (layers.scene) {
    sceneDoc.objects.forEach((object) => {
      const mesh = new Mesh(
        geometryFor(object),
        new MeshStandardMaterial({ color: object.color || DEFAULT_COLOR, roughness: 0.8, metalness: 0.1 }),
      );
      mesh.name = object.name;
      const attachment = attachments[object.id];
      const link = attachment && robot?.links?.[attachment.link];
      if (link) {
        applyPose(mesh, attachment.pose);
        link.add(mesh);
        attachedToLinks.push(mesh);
      } else {
        applyPose(mesh, object.pose);
        group.add(mesh);
      }
    });
  }

  if (layers.frames) {
    sceneDoc.frames.forEach((frame) => {
      const axes = new AxesHelper(FRAME_SIZE);
      axes.name = frame.name;
      applyPose(axes, frame.pose);
      group.add(axes);
    });
  }

  if (layers.path && sceneDoc.plannedPath?.length > 1) {
    const geometry = new BufferGeometry().setFromPoints(sceneDoc.plannedPath.map(p => new Vector3(...p)));
    group.add(new Line(geometry, new LineBasicMaterial({ color: pathColor })));
  }

  const dispose = () => {
    attachedToLinks.forEach(mesh => mesh.removeFromParent());
    [...attachedToLinks, group].forEach(root => root.traverse((obj) => {
      obj.geometry?.dispose();
      obj.material?.dispose();
    }));
    group.removeFromParent();
  };
  return { group, dispose };
};

export default buildCellScene;
