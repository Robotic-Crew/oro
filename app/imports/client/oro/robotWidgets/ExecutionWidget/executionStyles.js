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
 * Shared look of behavior tree executions (Execution and Cycle Timeline widgets).
 *
 * Steps are colored by the kind of skill (`type`), not by step name: a cell has a dozen step
 * names but only a few kinds, and a kind keeps its color across trees. Categorical palette in fixed
 * order, validated for both modes (CVD and contrast); light-mode contrast is below 3:1 for two
 * slots, so steps always come with a legend and a tooltip.
 */
const STEP_TYPES = [
  { type: 'move', label: 'Motion', light: '#2a78d6', dark: '#3987e5' },
  { type: 'perception', label: 'Perception', light: '#eb6834', dark: '#d95926' },
  { type: 'gripper', label: 'Gripper', light: '#1baf7a', dark: '#199e70' },
  { type: 'wait', label: 'Wait', light: '#eda100', dark: '#c98500' },
];
const OTHER_STEP = { type: 'other', label: 'Other', light: '#8b8a85', dark: '#7a7974' };

const stepType = type => STEP_TYPES.find(t => t.type === type) || OTHER_STEP;

const stepColor = (type, mode) => stepType(type)[mode === 'dark' ? 'dark' : 'light'];

// Results of a node or a cycle: a theme palette key, and a label (never color alone)
const RESULTS = {
  running: { label: 'Running', palette: 'info' },
  succeeded: { label: 'OK', palette: 'success' },
  failed: { label: 'Failed', palette: 'error' },
  cancelled: { label: 'Cancelled', palette: 'warning' },
  paused: { label: 'Paused', palette: 'warning' },
  idle: { label: 'Idle', palette: 'grey' },
};

const resultOf = state => RESULTS[state] || RESULTS.idle;

const formatDuration = (ms) => {
  if (!(ms >= 0)) {
    return '';
  }
  return ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`;
};

export {
  STEP_TYPES, OTHER_STEP, stepType, stepColor, resultOf, formatDuration,
};
