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
 * Perception widget: what the cell's camera saw on each perception attempt (e.g. Intrinsic Core's
 * pose estimation before a grasp), with the detections and the estimated pose drawn over the
 * capture, the confidence, and the history of attempts. Follows the latest attempt until one from
 * the history is selected. Images are fetched only for the results shown (see
 * usePerceptionImages) and always drawn with <img>, never in CSS. See the plugin README.
 */
import React, { useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import moment from 'moment';
import {
  Box, Button, Chip, Tooltip, Typography,
} from '@mui/material';
// Plugin modules
import { ENDPOINTS } from '../shared';
import { getPluginContext, getCollections } from './pluginContext';
import LoadingCircle from './LoadingCircle';
import usePerceptionImages from './usePerceptionImages';

const HISTORY_SIZE = 12;
// Pose axes: x, y, z as red, green, blue (the robotics convention), each also labeled
const AXES = [['x', '#e34948'], ['y', '#1baf7a'], ['z', '#2a78d6']];

// Images kept: the history, plus a few so following the latest does not refetch
const IMAGE_CACHE_SIZE = HISTORY_SIZE + 4;

const Overlay = ({ result }) => {
  const { width, height } = result;
  if (!width || !height) {
    return null;
  }
  const stroke = Math.max(2, width / 320);
  const font = Math.max(12, width / 40);
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="xMidYMid meet"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
    >
      {result.detections.map(({ label, score, bbox: [x, y, w, h] }, ix) => (
        // eslint-disable-next-line react/no-array-index-key
        <g key={ix}>
          <rect x={x} y={y} width={w} height={h} fill="none" stroke="#eda100" strokeWidth={stroke} />
          <rect x={x} y={y - font * 1.4} width={Math.max(w, font * 7)} height={font * 1.4} fill="#eda100" />
          <text x={x + font * 0.3} y={y - font * 0.35} fontSize={font} fill="#1a1a19">
            {`${label} ${Math.round(score * 100)}%`}
          </text>
        </g>
      ))}
      {result.poses.filter(p => p.axes).map(({ objectId, axes }) => (
        <g key={objectId}>
          {AXES.map(([axis, color]) => axes[axis] && (
            <g key={axis}>
              <line
                x1={axes.origin[0]}
                y1={axes.origin[1]}
                x2={axes[axis][0]}
                y2={axes[axis][1]}
                stroke={color}
                strokeWidth={stroke * 1.5}
                strokeLinecap="round"
              />
              <text x={axes[axis][0] + font * 0.3} y={axes[axis][1]} fontSize={font * 0.9} fill={color}>{axis}</text>
            </g>
          ))}
        </g>
      ))}
    </svg>
  );
};

Overlay.propTypes = { result: PropTypes.object.isRequired };

const ResultSummary = ({ result }) => {
  const confidence = result.poses[0]?.confidence;
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', px: 1, py: 0.5 }}>
      <Chip
        size="small"
        color={result.success ? 'success' : 'error'}
        label={result.success ? 'Pose found' : 'Not found'}
      />
      {confidence !== undefined && (
        <Typography variant="body2">{`Confidence ${Math.round(confidence * 100)}%`}</Typography>
      )}
      {result.error && <Typography variant="body2" color="error">{result.error}</Typography>}
      {result.imageDropped && (
        <Typography variant="body2" color="text.secondary">Image too big, not stored</Typography>
      )}
      <Typography variant="caption" color="text.secondary" sx={{ ml: 'auto' }}>
        {[result.cameraId, result.cycleId && `cycle ${result.cycleId}`, moment(result.ts).format('HH:mm:ss')]
          .filter(Boolean).join(' · ')}
      </Typography>
    </Box>
  );
};

ResultSummary.propTypes = { result: PropTypes.object.isRequired };

const PerceptionWidget = ({ robotId }) => {
  const [selectedId, setSelectedId] = useState(null);
  const { isLoading, results } = getPluginContext().meteor.useTracker(() => {
    const handle = getPluginContext().subscribe(ENDPOINTS.PERCEPTION, { robotId, limit: HISTORY_SIZE });
    return {
      isLoading: !handle.ready(),
      results: getCollections().perception.find({ robotId }, { sort: { ts: -1 }, limit: HISTORY_SIZE }).fetch(),
    };
  }, [robotId]);
  // Images to fetch: the selected one first, then the rest of the history
  const selectedForImages = (results.find(r => r._id === selectedId) || results[0])?._id;
  const resultIdsKey = results.filter(r => r.image).map(r => r._id).join(',');
  const imageIds = useMemo(() => {
    const ids = resultIdsKey ? resultIdsKey.split(',') : [];
    return ids.includes(selectedForImages) ? [selectedForImages, ...ids.filter(id => id !== selectedForImages)] : ids;
  }, [resultIdsKey, selectedForImages]);
  const images = usePerceptionImages(robotId, imageIds, IMAGE_CACHE_SIZE);

  if (isLoading) {
    return <Box sx={{ height: '100%', display: 'grid', placeItems: 'center' }}><LoadingCircle size={40} /></Box>;
  }
  if (results.length === 0) {
    return (
      <Box sx={{ height: '100%', display: 'grid', placeItems: 'center' }}>
        <Typography variant="body2" color="text.secondary">No perception results from this robot yet</Typography>
      </Box>
    );
  }
  // Follow the latest attempt unless one was picked (and is still in the history)
  const selected = results.find(r => r._id === selectedId) || results[0];
  const following = selected === results[0];
  const src = images[selected._id];

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <Box sx={{ position: 'relative', flex: 1, minHeight: 0, bgcolor: 'action.hover', borderRadius: 1 }}>
        {src && (
          <img
            src={src}
            alt="Perception capture"
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain' }}
          />
        )}
        <Overlay result={selected} />
        {!following && (
          <Button
            size="small"
            variant="contained"
            onClick={() => setSelectedId(null)}
            sx={{ position: 'absolute', top: 8, right: 8 }}
          >
            Latest
          </Button>
        )}
      </Box>
      <ResultSummary result={selected} />
      <Box sx={{ display: 'flex', gap: 0.5, px: 1, pb: 0.5, overflowX: 'auto' }}>
        {[...results].reverse().map(result => (
          <Tooltip
            key={result._id}
            title={`${moment(result.ts).format('HH:mm:ss')} · ${result.success ? 'found' : 'not found'}`}
            disableInteractive
          >
            <Box
              component="button"
              type="button"
              onClick={() => setSelectedId(result._id)}
              aria-label={`Perception attempt at ${moment(result.ts).format('HH:mm:ss')}`}
              sx={{
                p: 0,
                width: 48,
                height: 30,
                flexShrink: 0,
                cursor: 'pointer',
                borderRadius: 0.5,
                border: 2,
                borderColor: result.success ? 'success.main' : 'error.main',
                outline: result === selected ? '2px solid' : 'none',
                outlineColor: 'text.primary',
                outlineOffset: 1,
                overflow: 'hidden',
                bgcolor: 'action.hover',
              }}
            >
              {images[result._id] && (
                <img
                  src={images[result._id]}
                  alt=""
                  style={{ display: 'block', width: '100%', height: '100%', objectFit: 'cover' }}
                />
              )}
            </Box>
          </Tooltip>
        ))}
      </Box>
    </Box>
  );
};

PerceptionWidget.propTypes = {
  robotId: PropTypes.string,
};

export default PerceptionWidget;
