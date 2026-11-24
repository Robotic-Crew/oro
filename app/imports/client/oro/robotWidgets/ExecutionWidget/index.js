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
 * Execution widget: the behavior tree a skill-based cell (e.g. Intrinsic Core) is running, with
 * the state of each node, the node in progress and the error of a failed run.
 * See docs/intrinsic-core-widgets.md.
 */
import React, { useEffect, useState } from 'react';
import PropTypes from 'prop-types';
import { Meteor } from 'meteor/meteor';
import { useTracker } from 'meteor/react-meteor-data';
import {
  Alert, Box, Chip, Typography,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked';
import RemoveCircleOutlineIcon from '@mui/icons-material/RemoveCircleOutline';
import PlayCircleIcon from '@mui/icons-material/PlayCircle';
// ORO modules
import { Executions } from '../../../../lib/collections';
import WithNoDataMessage from '../../util/WithNoDataMessage';
import LoadingCircle from '../../util/LoadingCircle';
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

const TreeNode = ({ node, childrenOf, stateOf, currentNodeId, depth }) => {
  const theme = useTheme();
  const children = childrenOf[node.id] || [];
  const state = stateOf[node.id] || 'idle';
  const isLeaf = children.length === 0;
  const isCurrent = node.id === currentNodeId;
  return (
    <>
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
      {children.map(child => (
        <TreeNode
          key={child.id}
          node={child}
          childrenOf={childrenOf}
          stateOf={stateOf}
          currentNodeId={currentNodeId}
          depth={depth + 1}
        />
      ))}
    </>
  );
};

TreeNode.propTypes = {
  node: PropTypes.object.isRequired,
  childrenOf: PropTypes.object.isRequired,
  stateOf: PropTypes.object.isRequired,
  currentNodeId: PropTypes.string,
  depth: PropTypes.number.isRequired,
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

const ExecutionWidget = ({ robotId }) => {
  const { isLoading, execution } = useTracker(() => {
    const handle = Meteor.subscribe('executions', { robotId });
    return { isLoading: !handle.ready(), execution: Executions.findOne({ _id: robotId }) };
  }, [robotId]);
  const running = execution?.status === 'running';
  const now = useNow(running);

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

  const childrenOf = {};
  execution.nodes.forEach((node) => {
    (childrenOf[node.parentId || ''] = childrenOf[node.parentId || ''] || []).push(node);
  });
  const stateOf = Object.fromEntries(execution.nodeStates.map(s => [s.nodeId, s.state]));
  const roots = childrenOf[''] || [];
  const result = resultOf(execution.status);
  const elapsed = (running ? Math.max(now, execution.ts) : execution.ts) - execution.cycleStartTs;

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1, pb: 1, flexWrap: 'wrap' }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>{execution.treeName || execution.treeId}</Typography>
        <Chip size="small" label={result.label} color={result.palette === 'grey' ? 'default' : result.palette} />
        <Typography variant="caption" color="text.secondary" sx={{ ml: 'auto' }}>
          {execution.cycleId && `Cycle ${execution.cycleId} · `}
          {formatDuration(elapsed)}
        </Typography>
      </Box>
      {execution.error && (
        <Alert severity="error" sx={{ mx: 1, mb: 1, py: 0 }}>{execution.error}</Alert>
      )}
      <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {roots.map(node => (
          <TreeNode
            key={node.id}
            node={node}
            childrenOf={childrenOf}
            stateOf={stateOf}
            currentNodeId={execution.currentNodeId}
            depth={0}
          />
        ))}
      </Box>
    </Box>
  );
};

ExecutionWidget.propTypes = {
  robotId: PropTypes.string,
};

export default WithNoDataMessage(ExecutionWidget);
