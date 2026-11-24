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
 * 3D Model widget: the selected robot's URDF model, posed by its joint states, live or replayed
 * over the dashboard's time range. See docs/visualizer.md.
 *
 * This module holds the Meteor data and the controls; the three.js view (RobotModelView) is a
 * lazily loaded chunk.
 */
import React, {
  Suspense, useEffect, useMemo, useState,
} from 'react';
import PropTypes from 'prop-types';
import { Meteor } from 'meteor/meteor';
import { useTracker } from 'meteor/react-meteor-data';
import moment from 'moment';
import {
  Box, IconButton, Slider, ToggleButton, ToggleButtonGroup, Tooltip, Typography,
} from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import PauseIcon from '@mui/icons-material/Pause';
// ORO modules
import { Robots, RobotModels, Scenes } from '../../../../lib/collections';
import WithNoDataMessage from '../../util/WithNoDataMessage';
import LoadingCircle from '../../util/LoadingCircle';
import { prepareTimeVarsForQuery } from '../../util/timeUtils';
import useLiveJointSource from './useLiveJointSource';
import { ReplayJointSource } from './jointSources';
import { samplesFromHistory } from './jointSamples';

const RobotModelView = React.lazy(() => import('./RobotModelView'));

const LAYERS = [['scene', 'Cell'], ['frames', 'Frames'], ['path', 'Path']];

const MODE_LIVE = 'live';
const MODE_REPLAY = 'replay';
// jointStates.history accepts windows of up to 24 hours
const MAX_REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;

const Centered = ({ children }) => (
  <Box sx={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', p: 2, textAlign: 'center' }}>
    {children}
  </Box>
);

const useRobotModel = robotId => useTracker(() => {
  const robotHandle = Meteor.subscribe('robot.details', { robotId });
  const modelId = Robots.findOne({ _id: robotId }, { fields: { model: 1 } })?.model;
  const modelHandle = modelId && Meteor.subscribe('robot_models.forRobot', { robotId, modelId });
  // The cell around the robot, when it reports one (skill-based cells, e.g. Intrinsic Core)
  Meteor.subscribe('scenes', { robotId });
  return {
    isLoading: !robotHandle.ready() || (modelHandle && !modelHandle.ready()),
    modelId,
    model: modelId ? RobotModels.findOne({ _id: modelId }) : null,
    scene: Scenes.findOne({ _id: robotId }),
  };
}, [robotId]);

/** Loads the joint states history of the dashboard's time range into a ReplayJointSource. */
const useReplay = ({ robotId, namesRef, active, startTs, timeRangeMs }) => {
  const [replay, setReplay] = useState({});
  useEffect(() => {
    if (!active) {
      setReplay({});
      return undefined;
    }
    let cancelled = false;
    const load = async () => {
      const range = prepareTimeVarsForQuery(startTs, timeRangeMs, Date.now());
      const { endTs } = range;
      const from = Math.max(range.startTs, endTs - MAX_REPLAY_WINDOW_MS);
      const names = namesRef.current;
      if (!names.length) {
        setReplay({ message: 'No joint states received from this robot yet' });
        return;
      }
      setReplay({ isLoading: true });
      try {
        const history = await Meteor.callAsync('jointStates.history', {
          robotId, names, startTs: from, endTs,
        });
        const samples = samplesFromHistory(history);
        if (cancelled) {
          return;
        }
        // The slider spans the recorded part of the range, not the whole dashboard range
        setReplay(samples.length
          ? {
            source: new ReplayJointSource({
              samples, startTs: samples[0].t, endTs: samples[samples.length - 1].t,
            }),
            truncated: history.truncated,
          }
          : { message: 'No joint states recorded in this time range' });
      } catch (e) {
        if (!cancelled) {
          setReplay({ message: e.reason || e.message });
        }
      }
    };
    load();
    return () => { cancelled = true; };
  }, [robotId, active, startTs, timeRangeMs]);
  return replay;
};

/** Play/pause and a time slider for a ReplayJointSource. */
const ReplayControls = ({ source, truncated }) => {
  const [state, setState] = useState({ playbackTs: source.playbackTs, playing: false });
  useEffect(() => {
    const sync = () => setState({ playbackTs: source.playbackTs, playing: source.playing });
    sync();
    const unsubscribe = source.onChange(sync);
    // The source advances on animation frames: refresh the slider a few times per second
    const interval = setInterval(() => source.playing && sync(), 200);
    return () => {
      unsubscribe();
      clearInterval(interval);
    };
  }, [source]);

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flex: 1, minWidth: 0 }}>
      <IconButton
        size="small"
        aria-label={state.playing ? 'Pause' : 'Play'}
        onClick={() => (state.playing ? source.pause() : source.play())}
      >
        {state.playing ? <PauseIcon fontSize="small" /> : <PlayArrowIcon fontSize="small" />}
      </IconButton>
      <Slider
        size="small"
        min={source.startTs}
        max={source.endTs}
        value={state.playbackTs}
        onChange={(e, value) => source.seek(value)}
        aria-label="Replay time"
      />
      <Tooltip title={truncated ? 'Showing the first part of the time range only' : ''}>
        <Typography variant="caption" sx={{ whiteSpace: 'nowrap' }}>
          {moment(state.playbackTs).format('HH:mm:ss')}
          {truncated ? '*' : ''}
        </Typography>
      </Tooltip>
    </Box>
  );
};

ReplayControls.propTypes = {
  source: PropTypes.instanceOf(ReplayJointSource).isRequired,
  truncated: PropTypes.bool,
};

const RobotModelWidget = ({ robotId, startTs, timeRangeMs }) => {
  const { isLoading, modelId, model, scene } = useRobotModel(robotId);
  const [mode, setMode] = useState(MODE_LIVE);
  const [visibleLayers, setVisibleLayers] = useState(LAYERS.map(([layer]) => layer));
  const layers = useMemo(
    () => Object.fromEntries(LAYERS.map(([layer]) => [layer, visibleLayers.includes(layer)])),
    [visibleLayers],
  );
  const { source: liveSource, namesRef } = useLiveJointSource(robotId, !!model);
  const replay = useReplay({
    robotId, namesRef, active: mode === MODE_REPLAY, startTs, timeRangeMs,
  });

  if (isLoading) {
    return <Centered><LoadingCircle size={40} /></Centered>;
  }
  if (!model) {
    return (
      <Centered>
        <Typography variant="body2" color="text.secondary">
          {modelId
            ? `3D model "${modelId}" is not defined`
            : 'No 3D model configured for this robot'}
        </Typography>
      </Centered>
    );
  }

  const jointSource = mode === MODE_LIVE ? liveSource : replay.source;
  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Box sx={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <Suspense fallback={<Centered><LoadingCircle size={40} /></Centered>}>
          <RobotModelView model={model} jointSource={jointSource} scene={scene} layers={layers} />
        </Suspense>
        {mode === MODE_REPLAY && !replay.source && (
          <Box sx={{ position: 'absolute', left: 0, right: 0, bottom: 8, textAlign: 'center' }}>
            {replay.isLoading
              ? <LoadingCircle size={20} />
              : <Typography variant="caption" color="text.secondary">{replay.message}</Typography>}
          </Box>
        )}
      </Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1, py: 0.5 }}>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={mode}
          onChange={(e, value) => value && setMode(value)}
        >
          <ToggleButton value={MODE_LIVE}>Live</ToggleButton>
          <ToggleButton value={MODE_REPLAY}>Replay</ToggleButton>
        </ToggleButtonGroup>
        {mode === MODE_REPLAY && replay.source && (
          <ReplayControls source={replay.source} truncated={replay.truncated} />
        )}
        {scene && mode === MODE_LIVE && (
          <ToggleButtonGroup
            size="small"
            value={visibleLayers}
            onChange={(e, value) => setVisibleLayers(value)}
            aria-label="Visible layers"
            sx={{ ml: 'auto' }}
          >
            {LAYERS.map(([layer, label]) => <ToggleButton key={layer} value={layer}>{label}</ToggleButton>)}
          </ToggleButtonGroup>
        )}
      </Box>
    </Box>
  );
};

RobotModelWidget.propTypes = {
  robotId: PropTypes.string,
  // Dashboard time range, replayed in Replay mode
  startTs: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
  timeRangeMs: PropTypes.number,
};

export default WithNoDataMessage(RobotModelWidget);
