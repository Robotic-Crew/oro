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
 * Execution widget: the behavior tree a skill-based cell (e.g. Intrinsic Core) is running, with
 * the state of each node, the node in progress and the error of a failed run.
 * See the plugin README.
 */
import React, { useEffect, useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import {
  Alert, Box, Chip, Typography,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked';
import RemoveCircleOutlineIcon from '@mui/icons-material/RemoveCircleOutline';
import PlayCircleIcon from '@mui/icons-material/PlayCircle';
// Plugin modules
import { ENDPOINTS, treeRows } from '../shared';
import { getPluginContext, getCollections } from './pluginContext';
import LoadingCircle from './LoadingCircle';
import {
  stepColor, stepType, resultOf, formatDuration,
} from './executionStyles';

const StateIcon = ({ state }) => {
  const props = { fontSize: 'inherit', titleAccess: resultOf(state).label };
  switch (state) {
    case 'running':
      return <PlayCircleIcon color="info" {...props} />;
    case 'succeeded':
      return <CheckCircleIcon color="success" {...props} />;
    case 'failed':
      return <CancelIcon color="error" {...props} />;
    case 'cancelled':
      return <RemoveCircleOutlineIcon color="warning" {...props} />;
    default:
      return <RadioButtonUncheckedIcon color="disabled" {...props} />;
  }
};

StateIcon.propTypes = { state: PropTypes.string };

/** One node of the tree, indented by its depth. */
const TreeRow = ({ node, depth, isLeaf, state, isCurrent }) => {
  const theme = useTheme();
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        pl: 1 + depth * 2,
        pr: 1,
        py: 0.25,
        fontSize: 16,
        borderRadius: 1,
        bgcolor: isCurrent ? 'action.selected' : 'transparent',
      }}
    >
      <Box sx={{ width: 16, display: 'flex', justifyContent: 'center' }}><StateIcon state={state} /></Box>
      <Typography variant="body2" sx={{ fontWeight: isLeaf ? 400 : 600, flex: 1, minWidth: 0 }} noWrap>
        {node.name}
      </Typography>
      {isLeaf && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <Box sx={{ width: 8, height: 8, borderRadius: '2px', bgcolor: stepColor(node.type, theme.palette.mode) }} />
          <Typography variant="caption" color="text.secondary">{stepType(node.type).label}</Typography>
        </Box>
      )}
    </Box>
  );
};

TreeRow.propTypes = {
  node: PropTypes.object.isRequired,
  depth: PropTypes.number.isRequired,
  isLeaf: PropTypes.bool.isRequired,
  state: PropTypes.string.isRequired,
  isCurrent: PropTypes.bool.isRequired,
};

/** Re-renders every second while `active`, for elapsed times. */
const useNow = (active) => {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) {
      return undefined;
    }
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [active]);
  return now;
};

/** Elapsed time of the cycle; ticks on its own while running, so the tree is not re-rendered. */
const ElapsedClock = ({ running, ts, cycleStartTs }) => {
  const now = useNow(running);
  return formatDuration((running ? Math.max(now, ts) : ts) - cycleStartTs);
};

ElapsedClock.propTypes = {
  running: PropTypes.bool.isRequired,
  ts: PropTypes.number.isRequired,
  cycleStartTs: PropTypes.number.isRequired,
};

const ExecutionWidget = ({ robotId }) => {
  const { isLoading, execution } = getPluginContext().meteor.useTracker(() => {
    const handle = getPluginContext().subscribe(ENDPOINTS.EXECUTION, { robotId });
    return { isLoading: !handle.ready(), execution: getCollections().executions.findOne({ _id: robotId }) };
  }, [robotId]);
  const running = execution?.status === 'running';
  const nodes = execution?.nodes;
  // Safe with any tree a robot sends (cycles, missing ids, deep trees)
  const rows = useMemo(() => treeRows(nodes), [nodes]);

  if (isLoading) {
    return <Box sx={{ height: '100%', display: 'grid', placeItems: 'center' }}><LoadingCircle size={40} /></Box>;
  }
  if (!execution) {
    return (
      <Box sx={{ height: '100%', display: 'grid', placeItems: 'center' }}>
        <Typography variant="body2" color="text.secondary">No behavior tree executions reported by this robot</Typography>
      </Box>
    );
  }

  const stateOf = Object.fromEntries((execution.nodeStates || []).map(s => [s.nodeId, s.state]));
  const result = resultOf(execution.status);

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1, pb: 1, flexWrap: 'wrap' }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>{execution.treeName || execution.treeId}</Typography>
        <Chip size="small" label={result.label} color={result.palette === 'grey' ? 'default' : result.palette} />
        <Typography variant="caption" color="text.secondary" sx={{ ml: 'auto' }}>
          {execution.cycleId && `Cycle ${execution.cycleId} · `}
          <ElapsedClock running={running} ts={execution.ts} cycleStartTs={execution.cycleStartTs} />
        </Typography>
      </Box>
      {execution.error && (
        <Alert severity="error" sx={{ mx: 1, mb: 1, py: 0 }}>{execution.error}</Alert>
      )}
      <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {rows.map(({ node, depth, isLeaf }) => (
          <TreeRow
            key={node.id}
            node={node}
            depth={depth}
            isLeaf={isLeaf}
            state={stateOf[node.id] || 'idle'}
            isCurrent={node.id === execution.currentNodeId}
          />
        ))}
      </Box>
    </Box>
  );
};

ExecutionWidget.propTypes = {
  robotId: PropTypes.string,
};

export default ExecutionWidget;
