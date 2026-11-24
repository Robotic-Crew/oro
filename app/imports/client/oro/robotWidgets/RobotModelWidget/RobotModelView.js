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
 * The 3D view of a robot model, posed by a joint source.
 *
 * This is the only module that imports three.js, and it is loaded lazily (React.lazy in
 * index.js), so dashboards without a 3D widget never download it.
 *
 * The view draws through the page-wide SceneHost (one WebGL context, on-demand rendering) and
 * never re-renders React for motion: the joint source is polled on animation frames only while
 * it reports it is animating, and new data calls `onChange` listeners to wake the view up.
 */
import React, { useEffect, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import {
  Box3, Color, DirectionalLight, GridHelper, Group, HemisphereLight, PerspectiveCamera, Scene, Vector3,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Box, Typography } from '@mui/material';
import { useTheme } from '@mui/material/styles';
// ORO modules
import LoadingCircle from '../../util/LoadingCircle';
import getSceneHost from './three/sceneHost';
import { acquireModel, releaseModel } from './three/modelCache';
import buildCellScene from './three/cellScene';

/** Published joint values -> URDF joint values, renamed through the model's jointMap. */
const mapJointValues = (values, jointMap) => {
  if (!jointMap) {
    return values;
  }
  const mapped = {};
  Object.entries(values).forEach(([name, value]) => {
    mapped[jointMap[name] || name] = value;
  });
  return mapped;
};

/**
 * Aims the camera at the whole model, from the front-right and slightly above, and sizes the
 * floor grid to it.
 */
const frameModel = (object, camera, controls, grid) => {
  const box = new Box3().setFromObject(object);
  if (box.isEmpty()) {
    return;
  }
  const center = box.getCenter(new Vector3());
  const radius = box.getSize(new Vector3()).length() / 2 || 1;
  const distance = (radius / Math.sin((camera.fov * Math.PI) / 360)) * 0.95;
  camera.position.copy(center).add(new Vector3(1, 0.6, 1).normalize().multiplyScalar(distance));
  camera.near = distance / 100;
  camera.far = distance * 100;
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.update();
  grid.scale.setScalar(radius);
};

const RobotModelView = ({
  model, jointSource, scene, layers = { scene: true, frames: true, path: true },
}) => {
  const theme = useTheme();
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const viewRef = useRef(null);
  const [status, setStatus] = useState('loading');

  // Scene, camera, controls and the view registered in the SceneHost: once per mount
  useEffect(() => {
    const host = getSceneHost();
    const scene = new Scene();
    scene.add(new HemisphereLight(0xffffff, 0x666666, 2));
    const sun = new DirectionalLight(0xffffff, 2);
    sun.position.set(3, 5, 4);
    scene.add(sun);
    // 2x2 units, scaled to the model once it loads
    const grid = new GridHelper(2, 10, 0x888888, 0x888888);
    grid.material.opacity = 0.25;
    grid.material.transparent = true;
    scene.add(grid);
    // URDF is Z-up, three.js is Y-up
    const robotGroup = new Group();
    robotGroup.rotation.x = -Math.PI / 2;
    scene.add(robotGroup);

    const camera = new PerspectiveCamera(45, 1, 0.01, 100);
    camera.position.set(1.5, 1.2, 1.5);
    const controls = new OrbitControls(camera, containerRef.current);
    controls.target.set(0, 0.4, 0);
    controls.update();

    const view = {
      canvas: canvasRef.current,
      scene,
      camera,
      controls,
      grid,
      robotGroup,
      width: 0,
      height: 0,
      visible: true,
      background: new Color(),
      robot: null,
      jointMap: null,
      jointSource: null,
      onFrame: (now) => {
        if (!view.robot || !view.jointSource) {
          return { changed: false, animating: false };
        }
        const { values, animating } = view.jointSource.sample(now);
        const changed = !!values && view.robot.setJointValues(mapJointValues(values, view.jointMap));
        return { changed, animating };
      },
    };
    viewRef.current = view;
    host.register(view);

    controls.addEventListener('change', () => host.invalidate(view));

    const resizeObserver = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      view.width = Math.floor(width);
      view.height = Math.floor(height);
      camera.aspect = width / (height || 1);
      camera.updateProjectionMatrix();
      host.invalidate(view);
    });
    resizeObserver.observe(containerRef.current);

    const intersectionObserver = new IntersectionObserver(([entry]) => {
      view.visible = entry.isIntersecting;
      if (view.visible) {
        host.invalidate(view);
      }
    });
    intersectionObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      controls.dispose();
      host.unregister(view);
      viewRef.current = null;
    };
  }, []);

  // Background follows the theme
  useEffect(() => {
    const view = viewRef.current;
    view.background.set(theme.palette.background.paper);
    getSceneHost().invalidate(view);
  }, [theme.palette.background.paper]);

  // The model: shared through the model cache, swapped when the robot's model changes
  const { urdf, packages, jointMap } = model;
  useEffect(() => {
    const view = viewRef.current;
    const modelRef = { urdf, packages };
    let cancelled = false;
    setStatus('loading');
    acquireModel(modelRef).then((robot) => {
      if (cancelled) {
        return;
      }
      view.robotGroup.add(robot);
      view.robot = robot;
      view.jointMap = jointMap;
      // Frame the model in its zero pose; the next frame poses it
      view.scene.updateMatrixWorld(true);
      frameModel(view.robotGroup, view.camera, view.controls, view.grid);
      setStatus('ready');
      getSceneHost().invalidate(view);
    }, (err) => {
      if (!cancelled) {
        console.error('RobotModel: failed to load model', err);
        setStatus('error');
      }
    });
    return () => {
      cancelled = true;
      if (view.robot) {
        view.robot.removeFromParent();
        view.robot = null;
      }
      releaseModel(modelRef);
    };
  }, [urdf, JSON.stringify(packages), JSON.stringify(jointMap)]);

  // The cell around the robot: rebuilt when the scene document or the visible layers change
  const sceneTs = scene?.ts;
  const layersKey = JSON.stringify(layers);
  useEffect(() => {
    const view = viewRef.current;
    if (status !== 'ready' || !scene) {
      return undefined;
    }
    const cell = buildCellScene(scene, view.robot, layers, theme.palette.warning.main);
    view.robotGroup.add(cell.group);
    // Frame the whole cell the first time it shows up
    if (!view.framedWithScene) {
      view.framedWithScene = true;
      view.scene.updateMatrixWorld(true);
      frameModel(view.robotGroup, view.camera, view.controls, view.grid);
    }
    getSceneHost().invalidate(view);
    return () => {
      cell.dispose();
      getSceneHost().invalidate(view);
    };
  }, [status, sceneTs, layersKey, theme.palette.warning.main]);

  // Joint source: wake the view up when it has new data
  useEffect(() => {
    const view = viewRef.current;
    view.jointSource = jointSource;
    getSceneHost().invalidate(view);
    return jointSource?.onChange(() => getSceneHost().invalidate(view));
  }, [jointSource]);

  return (
    <Box ref={containerRef} sx={{ position: 'relative', width: '100%', height: '100%', minHeight: 0, touchAction: 'none' }}>
      <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%' }} />
      {status !== 'ready' && (
        <Box sx={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {status === 'loading'
            ? <LoadingCircle size={40} />
            : <Typography color="error">Could not load the robot model</Typography>}
        </Box>
      )}
    </Box>
  );
};

RobotModelView.propTypes = {
  model: PropTypes.shape({
    urdf: PropTypes.string.isRequired,
    packages: PropTypes.object,
    jointMap: PropTypes.object,
  }).isRequired,
  // { sample(now) -> { values, animating }, onChange(listener) -> unsubscribe }
  jointSource: PropTypes.object,
  // A `scenes` document: objects, frames, attached objects, planned path (see cellScene.js)
  scene: PropTypes.object,
  // Which parts of the scene to draw
  layers: PropTypes.shape({ scene: PropTypes.bool, frames: PropTypes.bool, path: PropTypes.bool }),
};

export default RobotModelView;
