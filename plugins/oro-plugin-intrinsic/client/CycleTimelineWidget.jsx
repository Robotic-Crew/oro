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
 * Cycle Timeline widget: the latest cycles of a skill-based cell as a Gantt chart. One row per
 * cycle (newest on top) on a shared time axis, so durations compare across cycles; one segment
 * per step, colored by the kind of skill. Shows where the cycle time goes and which step failed.
 * See the plugin README.
 */
import React from 'react';
import PropTypes from 'prop-types';
import moment from 'moment';
import { Box, Tooltip, Typography } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import PlayCircleIcon from '@mui/icons-material/PlayCircle';
// Plugin modules
import { ENDPOINTS } from '../shared';
import { getPluginContext, getCollections } from './pluginContext';
import LoadingCircle from './LoadingCircle';
import {
  STEP_TYPES, OTHER_STEP, stepColor, stepType, formatDuration,
} from './executionStyles';

const MAX_CYCLES = 12;
// Steps read: enough for MAX_CYCLES typical cycles (the server caps it at MAX_STEPS)
const STEPS_LIMIT = 150;
const LABEL_WIDTH = 92;
const ROW_HEIGHT = 18;

/** Steps (newest first) -> cycles (newest first): { cycleId, startTs, endTs, steps, failed } */
const groupCycles = (steps) => {
  const byCycle = new Map();
  steps.forEach((step) => {
    if (!byCycle.has(step.cycleId)) {
      byCycle.set(step.cycleId, []);
    }
    byCycle.get(step.cycleId).push(step);
  });
  return [...byCycle.entries()].slice(0, MAX_CYCLES).map(([cycleId, cycleSteps]) => ({
    cycleId,
    steps: cycleSteps,
    startTs: Math.min(...cycleSteps.map(s => s.startTs)),
    endTs: Math.max(...cycleSteps.map(s => s.endTs)),
    failed: cycleSteps.some(s => s.result === 'failed'),
  }));
};

/** Round axis ticks: 0, step, 2*step... covering `maxMs` */
const ticksFor = (maxMs) => {
  const candidates = [1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000];
  const step = candidates.find(c => maxMs / c <= 6) || 600000;
  const ticks = [];
  for (let t = 0; t <= maxMs; t += step) {
    ticks.push(t);
  }
  return ticks;
};

const Segment = ({ step, cycleStartTs, scaleMs, mode }) => {
  const left = ((step.startTs - cycleStartTs) / scaleMs) * 100;
  const width = Math.max(0.4, ((step.endTs - step.startTs) / scaleMs) * 100);
  const failed = step.result === 'failed';
  return (
    <Tooltip
      arrow
      disableInteractive
      title={(
        <>
          <b>{step.name}</b>
          <br />
          {`${stepType(step.type).label} · ${formatDuration(step.endTs - step.startTs)}`}
          {failed && ' · Failed'}
        </>
      )}
    >
      <Box
        sx={{
          position: 'absolute',
          top: 2,
          bottom: 2,
          left: `${left}%`,
          width: `${width}%`,
          // 1px surface gap on each side between adjacent segments
          px: '1px',
          backgroundClip: 'content-box',
          bgcolor: stepColor(step.type, mode),
          borderRadius: '4px',
          outline: failed ? '2px solid' : 'none',
          outlineColor: 'error.main',
          outlineOffset: '-1px',
          cursor: 'default',
        }}
      />
    </Tooltip>
  );
};

Segment.propTypes = {
  step: PropTypes.object.isRequired,
  cycleStartTs: PropTypes.number.isRequired,
  scaleMs: PropTypes.number.isRequired,
  mode: PropTypes.string.isRequired,
};

const CycleTimelineWidget = ({ robotId }) => {
  const theme = useTheme();
  const { mode } = theme.palette;
  const { isLoading, steps, runningCycleId } = getPluginContext().meteor.useTracker(() => {
    const ctx = getPluginContext();
    const { executions, steps: stepsCollection } = getCollections();
    const handle = ctx.subscribe(ENDPOINTS.STEPS, { robotId, limit: STEPS_LIMIT });
    ctx.subscribe(ENDPOINTS.EXECUTION, { robotId });
    const execution = executions.findOne({ _id: robotId }, { fields: { status: 1, cycleId: 1 } });
    return {
      isLoading: !handle.ready(),
      steps: stepsCollection.find({ robotId }, { sort: { endTs: -1 }, limit: STEPS_LIMIT }).fetch(),
      // The cycle still running (its finished steps so far are shown, but it has no result yet)
      runningCycleId: execution?.status === 'running' ? execution.cycleId : null,
    };
  }, [robotId]);

  if (isLoading) {
    return <Box sx={{ height: '100%', display: 'grid', placeItems: 'center' }}><LoadingCircle size={40} /></Box>;
  }
  const cycles = groupCycles(steps);
  if (cycles.length === 0) {
    return (
      <Box sx={{ height: '100%', display: 'grid', placeItems: 'center' }}>
        <Typography variant="body2" color="text.secondary">No cycles recorded for this robot yet</Typography>
      </Box>
    );
  }

  const scaleMs = Math.max(...cycles.map(c => c.endTs - c.startTs)) * 1.02;
  const ticks = ticksFor(scaleMs);
  const typesShown = [...STEP_TYPES, OTHER_STEP].filter(t => steps.some(s => stepType(s.type).type === t.type));
  const durations = cycles.filter(c => !c.failed && c.cycleId !== runningCycleId).map(c => c.endTs - c.startTs);
  const avgOk = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null;

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0, px: 1 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap', pb: 1 }}>
        {typesShown.map(t => (
          <Box key={t.type} sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <Box sx={{ width: 10, height: 10, borderRadius: '2px', bgcolor: stepColor(t.type, mode) }} />
            <Typography variant="caption" color="text.secondary">{t.label}</Typography>
          </Box>
        ))}
        {avgOk !== null && (
          <Typography variant="caption" color="text.secondary" sx={{ ml: 'auto' }}>
            {`Average OK cycle: ${formatDuration(avgOk)}`}
          </Typography>
        )}
      </Box>
      <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {cycles.map(cycle => (
          <Box key={cycle.cycleId} sx={{ display: 'flex', alignItems: 'center', height: ROW_HEIGHT + 6 }}>
            <Box sx={{ width: LABEL_WIDTH, display: 'flex', alignItems: 'center', gap: 0.5, flexShrink: 0 }}>
              {cycle.failed && <CancelIcon color="error" sx={{ fontSize: 14 }} titleAccess="Failed" />}
              {!cycle.failed && cycle.cycleId === runningCycleId
                && <PlayCircleIcon color="info" sx={{ fontSize: 14 }} titleAccess="Running" />}
              {!cycle.failed && cycle.cycleId !== runningCycleId
                && <CheckCircleIcon color="success" sx={{ fontSize: 14 }} titleAccess="OK" />}
              <Typography variant="caption" color="text.secondary">{moment(cycle.startTs).format('HH:mm:ss')}</Typography>
            </Box>
            <Box sx={{ position: 'relative', flex: 1, height: ROW_HEIGHT }}>
              {cycle.steps.map(step => (
                <Segment key={step._id} step={step} cycleStartTs={cycle.startTs} scaleMs={scaleMs} mode={mode} />
              ))}
            </Box>
            <Typography variant="caption" color="text.secondary" sx={{ width: 52, textAlign: 'right', flexShrink: 0 }}>
              {formatDuration(cycle.endTs - cycle.startTs)}
            </Typography>
          </Box>
        ))}
      </Box>
      {/* Time axis, from the start of each cycle */}
      <Box sx={{ display: 'flex', pt: 0.5 }}>
        <Box sx={{ width: LABEL_WIDTH, flexShrink: 0 }} />
        <Box sx={{ position: 'relative', flex: 1, height: 16, borderTop: 1, borderColor: 'divider' }}>
          {ticks.map(t => (
            <Typography
              key={t}
              variant="caption"
              color="text.secondary"
              sx={{ position: 'absolute', left: `${(t / scaleMs) * 100}%`, transform: 'translateX(-50%)', fontSize: 10 }}
            >
              {`${t / 1000}s`}
            </Typography>
          ))}
        </Box>
        <Box sx={{ width: 52, flexShrink: 0 }} />
      </Box>
    </Box>
  );
};

CycleTimelineWidget.propTypes = {
  robotId: PropTypes.string,
};

export default CycleTimelineWidget;
