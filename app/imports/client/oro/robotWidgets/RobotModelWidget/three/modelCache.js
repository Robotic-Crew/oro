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
 * Loads URDF robot models, once per model, for every 3D view on the page.
 *
 * The first `acquireModel()` of a URDF downloads and parses it (with all its meshes); later ones,
 * from other widgets showing a robot of the same type, get a clone sharing the same geometries
 * and materials (GPU buffers included). Reference counted: the shared resources are disposed when
 * the last view releases the model. The browser HTTP cache takes care of later page loads.
 *
 * Meshes may be STL or Collada (as in most ROS description packages) or glTF/GLB, optionally
 * meshopt-compressed, which is what tools/urdf_optimize.py produces.
 */
import { LoadingManager } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import URDFLoader from 'urdf-loader';

const entries = new Map();

const keyOf = ({ urdf, packages }) => JSON.stringify([urdf, packages || null]);

const disposeObject = (root) => {
  root.traverse((obj) => {
    if (obj.geometry) {
      obj.geometry.dispose();
    }
    const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
    materials.forEach((m) => m?.dispose?.());
  });
};

const loadModel = ({ urdf, packages }) => new Promise((resolve, reject) => {
  // Its own manager, so onLoad fires when this model's URDF and all of its meshes are in
  const manager = new LoadingManager();
  const loader = new URDFLoader(manager);
  loader.packages = packages || '';
  const gltfLoader = new GLTFLoader(manager).setMeshoptDecoder(MeshoptDecoder);
  loader.loadMeshCb = (path, meshManager, material, done) => {
    if (/\.(glb|gltf)$/i.test(path)) {
      gltfLoader.load(path, (gltf) => done(gltf.scene), null, (err) => done(null, err));
    } else {
      loader.defaultMeshLoader(path, meshManager, material, done);
    }
  };
  let robot = null;
  let failed = false;
  manager.onLoad = () => {
    if (robot && !failed) {
      resolve(robot);
    }
  };
  manager.onError = (url) => {
    // A missing mesh is not fatal (the link is drawn without it), the URDF itself is
    if (url === manager.resolveURL(urdf)) {
      failed = true;
      reject(new Error(`Could not load robot model ${urdf}`));
    } else {
      console.warn(`RobotModel: could not load mesh ${url}`);
    }
  };
  loader.load(urdf, (result) => { robot = result; }, null, (err) => {
    failed = true;
    reject(err);
  });
});

/**
 * Resolves with a model instance (an URDFRobot) for `model` ({ urdf, packages }). Every call
 * must be paired with a `releaseModel(model)`, even if the promise rejects.
 */
const acquireModel = (model) => {
  const key = keyOf(model);
  let entry = entries.get(key);
  if (!entry) {
    entry = { refs: 0, template: null };
    entry.promise = loadModel(model).then((robot) => {
      entry.template = robot;
      return robot;
    });
    entries.set(key, entry);
  }
  entry.refs += 1;
  return entry.promise.then((template) => template.clone());
};

const releaseModel = (model) => {
  const key = keyOf(model);
  const entry = entries.get(key);
  if (!entry) {
    return;
  }
  entry.refs -= 1;
  if (entry.refs <= 0) {
    entries.delete(key);
    entry.promise.then((template) => disposeObject(template), () => {});
  }
};

export { acquireModel, releaseModel };
