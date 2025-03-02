/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import {
  importFromChromeTimeline,
  Flamechart as SpeedscopeFlamechart,
} from '@elg/speedscope';
import type {TimelineEvent} from '@elg/speedscope';
import type {
  BatchUID,
  Flamechart,
  Milliseconds,
  NativeEvent,
  Phase,
  ReactLane,
  ReactComponentMeasure,
  ReactMeasure,
  ReactMeasureType,
  ReactProfilerData,
  SchedulingEvent,
  SuspenseEvent,
} from '../types';

import {REACT_TOTAL_NUM_LANES, SCHEDULING_PROFILER_VERSION} from '../constants';
import InvalidProfileError from './InvalidProfileError';
import {getBatchRange} from '../utils/getBatchRange';

type MeasureStackElement = {|
  type: ReactMeasureType,
  depth: number,
  measure: ReactMeasure,
  startTime: Milliseconds,
  stopTime?: Milliseconds,
|};

type ProcessorState = {|
  batchUID: BatchUID,
  currentReactComponentMeasure: ReactComponentMeasure | null,
  measureStack: MeasureStackElement[],
  nativeEventStack: NativeEvent[],
  nextRenderShouldGenerateNewBatchID: boolean,
  potentialLongEvents: Array<[NativeEvent, BatchUID]>,
  potentialLongNestedUpdate: SchedulingEvent | null,
  potentialLongNestedUpdates: Array<[SchedulingEvent, BatchUID]>,
  potentialSuspenseEventsOutsideOfTransition: Array<
    [SuspenseEvent, ReactLane[]],
  >,
  uidCounter: BatchUID,
  unresolvedSuspenseEvents: Map<string, SuspenseEvent>,
|};

const NATIVE_EVENT_DURATION_THRESHOLD = 20;
const NESTED_UPDATE_DURATION_THRESHOLD = 20;

const WARNING_STRINGS = {
  LONG_EVENT_HANDLER:
    'An event handler scheduled a big update with React. Consider using the Transition API to defer some of this work.',
  NESTED_UPDATE:
    'A big nested update was scheduled during layout. ' +
    'Nested updates require React to re-render synchronously before the browser can paint. ' +
    'Consider delaying this update by moving it to a passive effect (useEffect).',
  SUSPEND_DURING_UPATE:
    'A component suspended during an update which caused a fallback to be shown. ' +
    "Consider using the Transition API to avoid hiding components after they've been mounted.",
};

// Exported for tests
export function getLanesFromTransportDecimalBitmask(
  laneBitmaskString: string,
): ReactLane[] {
  const laneBitmask = parseInt(laneBitmaskString, 10);

  // As negative numbers are stored in two's complement format, our bitmask
  // checks will be thrown off by them.
  if (laneBitmask < 0) {
    return [];
  }

  const lanes = [];
  let powersOfTwo = 0;
  while (powersOfTwo <= REACT_TOTAL_NUM_LANES) {
    if ((1 << powersOfTwo) & laneBitmask) {
      lanes.push(powersOfTwo);
    }
    powersOfTwo++;
  }
  return lanes;
}

function updateLaneToLabelMap(
  profilerData: ReactProfilerData,
  laneLabelTuplesString: string,
): void {
  // These marks appear multiple times in the data;
  // We only need to extact them once.
  if (profilerData.laneToLabelMap.size === 0) {
    const laneLabelTuples = laneLabelTuplesString.split(',');
    for (let laneIndex = 0; laneIndex < laneLabelTuples.length; laneIndex++) {
      // The numeric lane value (e.g. 64) isn't important.
      // The profiler parses and stores the lane's position within the bitmap,
      // (e.g. lane 1 is index 0, lane 16 is index 4).
      profilerData.laneToLabelMap.set(laneIndex, laneLabelTuples[laneIndex]);
    }
  }
}

let profilerVersion = null;

function getLastType(stack: $PropertyType<ProcessorState, 'measureStack'>) {
  if (stack.length > 0) {
    const {type} = stack[stack.length - 1];
    return type;
  }
  return null;
}

function getDepth(stack: $PropertyType<ProcessorState, 'measureStack'>) {
  if (stack.length > 0) {
    const {depth, type} = stack[stack.length - 1];
    return type === 'render-idle' ? depth : depth + 1;
  }
  return 0;
}

function markWorkStarted(
  type: ReactMeasureType,
  startTime: Milliseconds,
  lanes: ReactLane[],
  currentProfilerData: ReactProfilerData,
  state: ProcessorState,
) {
  const {batchUID, measureStack} = state;
  const depth = getDepth(measureStack);

  const measure: ReactMeasure = {
    type,
    batchUID,
    depth,
    lanes,
    timestamp: startTime,
    duration: 0,
  };

  state.measureStack.push({depth, measure, startTime, type});

  // This array is pre-initialized when the batchUID is generated.
  const measures = currentProfilerData.batchUIDToMeasuresMap.get(batchUID);
  if (measures != null) {
    measures.push(measure);
  } else {
    currentProfilerData.batchUIDToMeasuresMap.set(state.batchUID, [measure]);
  }

  // This array is pre-initialized before processing starts.
  lanes.forEach(lane => {
    ((currentProfilerData.laneToReactMeasureMap.get(
      lane,
    ): any): ReactMeasure[]).push(measure);
  });
}

function markWorkCompleted(
  type: ReactMeasureType,
  stopTime: Milliseconds,
  currentProfilerData: ReactProfilerData,
  stack: $PropertyType<ProcessorState, 'measureStack'>,
) {
  if (stack.length === 0) {
    console.error(
      'Unexpected type "%s" completed at %sms while stack is empty.',
      type,
      stopTime,
    );
    // Ignore work "completion" user timing mark that doesn't complete anything
    return;
  }

  const last = stack[stack.length - 1];
  if (last.type !== type) {
    console.error(
      'Unexpected type "%s" completed at %sms before "%s" completed.',
      type,
      stopTime,
      last.type,
    );
  }

  const {measure, startTime} = stack.pop();
  if (!measure) {
    console.error('Could not find matching measure for type "%s".', type);
  }

  // $FlowFixMe This property should not be writable outside of this function.
  measure.duration = stopTime - startTime;
}

function throwIfIncomplete(
  type: ReactMeasureType,
  stack: $PropertyType<ProcessorState, 'measureStack'>,
) {
  const lastIndex = stack.length - 1;
  if (lastIndex >= 0) {
    const last = stack[lastIndex];
    if (last.stopTime === undefined && last.type === type) {
      throw new InvalidProfileError(
        `Unexpected type "${type}" started before "${last.type}" completed.`,
      );
    }
  }
}

function processTimelineEvent(
  event: TimelineEvent,
  /** Finalized profiler data up to `event`. May be mutated. */
  currentProfilerData: ReactProfilerData,
  /** Intermediate processor state. May be mutated. */
  state: ProcessorState,
) {
  const {args, cat, name, ts, ph} = event;
  switch (cat) {
    case 'devtools.timeline':
      if (name === 'EventDispatch') {
        const type = args.data.type;

        if (type.startsWith('react-')) {
          const stackTrace = args.data.stackTrace;
          if (stackTrace) {
            const topFrame = stackTrace[stackTrace.length - 1];
            if (topFrame.url.includes('/react-dom.')) {
              // Filter out fake React events dispatched by invokeGuardedCallbackDev.
              return;
            }
          }
        }

        // Reduce noise from events like DOMActivate, load/unload, etc. which are usually not relevant
        if (
          type.startsWith('blur') ||
          type.startsWith('click') ||
          type.startsWith('focus') ||
          type.startsWith('mouse') ||
          type.startsWith('pointer')
        ) {
          const timestamp = (ts - currentProfilerData.startTime) / 1000;
          const duration = event.dur / 1000;

          let depth = 0;

          while (state.nativeEventStack.length > 0) {
            const prevNativeEvent =
              state.nativeEventStack[state.nativeEventStack.length - 1];
            const prevStopTime =
              prevNativeEvent.timestamp + prevNativeEvent.duration;

            if (timestamp < prevStopTime) {
              depth = prevNativeEvent.depth + 1;
              break;
            } else {
              state.nativeEventStack.pop();
            }
          }

          const nativeEvent = {
            depth,
            duration,
            timestamp,
            type,
            warning: null,
          };

          currentProfilerData.nativeEvents.push(nativeEvent);

          // Keep track of curent event in case future ones overlap.
          // We separate them into different vertical lanes in this case.
          state.nativeEventStack.push(nativeEvent);
        }
      }
      break;
    case 'blink.user_timing':
      const startTime = (ts - currentProfilerData.startTime) / 1000;

      if (name.startsWith('--react-version-')) {
        const [reactVersion] = name.substr(16).split('-');
        currentProfilerData.reactVersion = reactVersion;
      } else if (name.startsWith('--profiler-version-')) {
        const [versionString] = name.substr(19).split('-');
        profilerVersion = parseInt(versionString, 10);
        if (profilerVersion !== SCHEDULING_PROFILER_VERSION) {
          throw new InvalidProfileError(
            `This version of profiling data (${versionString}) is not supported by the current profiler.`,
          );
        }
      } else if (name.startsWith('--react-lane-labels-')) {
        const [laneLabelTuplesString] = name.substr(20).split('-');
        updateLaneToLabelMap(currentProfilerData, laneLabelTuplesString);
      } else if (name.startsWith('--component-render-start-')) {
        const [componentName] = name.substr(25).split('-');

        if (state.currentReactComponentMeasure !== null) {
          console.error(
            'Render started while another render in progress:',
            state.currentReactComponentMeasure,
          );
        }

        state.currentReactComponentMeasure = {
          componentName,
          timestamp: startTime,
          duration: 0,
          warning: null,
        };
      } else if (name === '--component-render-stop') {
        if (state.currentReactComponentMeasure !== null) {
          const componentMeasure = state.currentReactComponentMeasure;
          componentMeasure.duration = startTime - componentMeasure.timestamp;

          state.currentReactComponentMeasure = null;

          currentProfilerData.componentMeasures.push(componentMeasure);
        }
      } else if (name.startsWith('--schedule-render-')) {
        const [laneBitmaskString] = name.substr(18).split('-');

        currentProfilerData.schedulingEvents.push({
          type: 'schedule-render',
          lanes: getLanesFromTransportDecimalBitmask(laneBitmaskString),
          timestamp: startTime,
          warning: null,
        });
      } else if (name.startsWith('--schedule-forced-update-')) {
        const [laneBitmaskString, componentName] = name.substr(25).split('-');

        const forceUpdateEvent = {
          type: 'schedule-force-update',
          lanes: getLanesFromTransportDecimalBitmask(laneBitmaskString),
          componentName,
          timestamp: startTime,
          warning: null,
        };

        // If this is a nested update, make a note of it.
        // Once we're done processing events, we'll check to see if it was a long update and warn about it.
        if (state.measureStack.find(({type}) => type === 'commit')) {
          state.potentialLongNestedUpdate = forceUpdateEvent;
        }

        currentProfilerData.schedulingEvents.push(forceUpdateEvent);
      } else if (name.startsWith('--schedule-state-update-')) {
        const [laneBitmaskString, componentName] = name.substr(24).split('-');

        const stateUpdateEvent = {
          type: 'schedule-state-update',
          lanes: getLanesFromTransportDecimalBitmask(laneBitmaskString),
          componentName,
          timestamp: startTime,
          warning: null,
        };

        // If this is a nested update, make a note of it.
        // Once we're done processing events, we'll check to see if it was a long update and warn about it.
        if (state.measureStack.find(({type}) => type === 'commit')) {
          state.potentialLongNestedUpdate = stateUpdateEvent;
        }

        currentProfilerData.schedulingEvents.push(stateUpdateEvent);
      } // eslint-disable-line brace-style

      // React Events - suspense
      else if (name.startsWith('--suspense-suspend-')) {
        const [id, componentName, phase, laneBitmaskString] = name
          .substr(19)
          .split('-');
        const lanes = getLanesFromTransportDecimalBitmask(laneBitmaskString);

        const availableDepths = new Array(
          state.unresolvedSuspenseEvents.size + 1,
        ).fill(true);
        state.unresolvedSuspenseEvents.forEach(({depth}) => {
          availableDepths[depth] = false;
        });

        let depth = 0;
        for (let i = 0; i < availableDepths.length; i++) {
          if (availableDepths[i]) {
            depth = i;
            break;
          }
        }

        // TODO (scheduling profiler) Maybe we should calculate depth in post,
        // so unresolved Suspense requests don't take up space.
        // We can't know if they'll be resolved or not at this point.
        // We'll just give them a default (fake) duration width.

        const suspenseEvent = {
          componentName,
          depth,
          duration: null,
          id,
          phase: ((phase: any): Phase),
          resolution: 'unresolved',
          resuspendTimestamps: null,
          timestamp: startTime,
          type: 'suspense',
          warning: null,
        };

        if (phase === 'update') {
          // If a component suspended during an update, we should verify that it was during a transition.
          // We need the lane metadata to verify this though.
          // Since that data is only logged during commit, we may not have it yet.
          // Store these events for post-processing then.
          state.potentialSuspenseEventsOutsideOfTransition.push([
            suspenseEvent,
            lanes,
          ]);
        }

        currentProfilerData.suspenseEvents.push(suspenseEvent);
        state.unresolvedSuspenseEvents.set(id, suspenseEvent);
      } else if (name.startsWith('--suspense-resuspend-')) {
        const [id] = name.substr(21).split('-');
        const suspenseEvent = state.unresolvedSuspenseEvents.get(id);
        if (suspenseEvent != null) {
          if (suspenseEvent.resuspendTimestamps === null) {
            suspenseEvent.resuspendTimestamps = [startTime];
          } else {
            suspenseEvent.resuspendTimestamps.push(startTime);
          }
        }
      } else if (name.startsWith('--suspense-resolved-')) {
        const [id] = name.substr(20).split('-');
        const suspenseEvent = state.unresolvedSuspenseEvents.get(id);
        if (suspenseEvent != null) {
          state.unresolvedSuspenseEvents.delete(id);

          suspenseEvent.duration = startTime - suspenseEvent.timestamp;
          suspenseEvent.resolution = 'resolved';
        }
      } else if (name.startsWith('--suspense-rejected-')) {
        const [id] = name.substr(20).split('-');
        const suspenseEvent = state.unresolvedSuspenseEvents.get(id);
        if (suspenseEvent != null) {
          state.unresolvedSuspenseEvents.delete(id);

          suspenseEvent.duration = startTime - suspenseEvent.timestamp;
          suspenseEvent.resolution = 'rejected';
        }
      } // eslint-disable-line brace-style

      // React Measures - render
      else if (name.startsWith('--render-start-')) {
        if (state.nextRenderShouldGenerateNewBatchID) {
          state.nextRenderShouldGenerateNewBatchID = false;
          state.batchUID = ((state.uidCounter++: any): BatchUID);
        }

        // If this render is the result of a nested update, make a note of it.
        // Once we're done processing events, we'll check to see if it was a long update and warn about it.
        if (state.potentialLongNestedUpdate !== null) {
          state.potentialLongNestedUpdates.push([
            state.potentialLongNestedUpdate,
            state.batchUID,
          ]);
          state.potentialLongNestedUpdate = null;
        }

        const [laneBitmaskString] = name.substr(15).split('-');

        throwIfIncomplete('render', state.measureStack);
        if (getLastType(state.measureStack) !== 'render-idle') {
          markWorkStarted(
            'render-idle',
            startTime,
            getLanesFromTransportDecimalBitmask(laneBitmaskString),
            currentProfilerData,
            state,
          );
        }
        markWorkStarted(
          'render',
          startTime,
          getLanesFromTransportDecimalBitmask(laneBitmaskString),
          currentProfilerData,
          state,
        );

        for (let i = 0; i < state.nativeEventStack.length; i++) {
          const nativeEvent = state.nativeEventStack[i];
          const stopTime = nativeEvent.timestamp + nativeEvent.duration;

          // If React work was scheduled during an event handler, and the event had a long duration,
          // it might be because the React render was long and stretched the event.
          // It might also be that the React work was short and that something else stretched the event.
          // Make a note of this event for now and we'll examine the batch of React render work later.
          // (We can't know until we're done processing the React update anyway.)
          if (stopTime > startTime) {
            state.potentialLongEvents.push([nativeEvent, state.batchUID]);
          }
        }
      } else if (
        name.startsWith('--render-stop') ||
        name.startsWith('--render-yield')
      ) {
        markWorkCompleted(
          'render',
          startTime,
          currentProfilerData,
          state.measureStack,
        );
      } else if (name.startsWith('--render-cancel')) {
        state.nextRenderShouldGenerateNewBatchID = true;
        markWorkCompleted(
          'render',
          startTime,
          currentProfilerData,
          state.measureStack,
        );
        markWorkCompleted(
          'render-idle',
          startTime,
          currentProfilerData,
          state.measureStack,
        );
      } // eslint-disable-line brace-style

      // React Measures - commits
      else if (name.startsWith('--commit-start-')) {
        state.nextRenderShouldGenerateNewBatchID = true;
        const [laneBitmaskString] = name.substr(15).split('-');

        markWorkStarted(
          'commit',
          startTime,
          getLanesFromTransportDecimalBitmask(laneBitmaskString),
          currentProfilerData,
          state,
        );
      } else if (name.startsWith('--commit-stop')) {
        markWorkCompleted(
          'commit',
          startTime,
          currentProfilerData,
          state.measureStack,
        );
        markWorkCompleted(
          'render-idle',
          startTime,
          currentProfilerData,
          state.measureStack,
        );
      } // eslint-disable-line brace-style

      // React Measures - layout effects
      else if (name.startsWith('--layout-effects-start-')) {
        const [laneBitmaskString] = name.substr(23).split('-');

        markWorkStarted(
          'layout-effects',
          startTime,
          getLanesFromTransportDecimalBitmask(laneBitmaskString),
          currentProfilerData,
          state,
        );
      } else if (name.startsWith('--layout-effects-stop')) {
        markWorkCompleted(
          'layout-effects',
          startTime,
          currentProfilerData,
          state.measureStack,
        );
      } // eslint-disable-line brace-style

      // React Measures - passive effects
      else if (name.startsWith('--passive-effects-start-')) {
        const [laneBitmaskString] = name.substr(24).split('-');

        markWorkStarted(
          'passive-effects',
          startTime,
          getLanesFromTransportDecimalBitmask(laneBitmaskString),
          currentProfilerData,
          state,
        );
      } else if (name.startsWith('--passive-effects-stop')) {
        markWorkCompleted(
          'passive-effects',
          startTime,
          currentProfilerData,
          state.measureStack,
        );
      } // eslint-disable-line brace-style

      // Other user timing marks/measures
      else if (ph === 'R' || ph === 'n') {
        // User Timing mark
        currentProfilerData.otherUserTimingMarks.push({
          name,
          timestamp: startTime,
        });
      } else if (ph === 'b') {
        // TODO: Begin user timing measure
      } else if (ph === 'e') {
        // TODO: End user timing measure
      } else if (ph === 'i' || ph === 'I') {
        // Instant events.
        // Note that the capital "I" is a deprecated value that exists in Chrome Canary traces.
      } // eslint-disable-line brace-style

      // Unrecognized event
      else {
        throw new InvalidProfileError(
          `Unrecognized event ${JSON.stringify(
            event,
          )}! This is likely a bug in this profiler tool.`,
        );
      }
      break;
  }
}

function preprocessFlamechart(rawData: TimelineEvent[]): Flamechart {
  let parsedData;
  try {
    parsedData = importFromChromeTimeline(rawData, 'react-devtools');
  } catch (error) {
    // Assume any Speedscope errors are caused by bad profiles
    const errorToRethrow = new InvalidProfileError(error.message);
    errorToRethrow.stack = error.stack;
    throw errorToRethrow;
  }

  const profile = parsedData.profiles[0]; // TODO: Choose the main CPU thread only

  const speedscopeFlamechart = new SpeedscopeFlamechart({
    getTotalWeight: profile.getTotalWeight.bind(profile),
    forEachCall: profile.forEachCall.bind(profile),
    formatValue: profile.formatValue.bind(profile),
    getColorBucketForFrame: () => 0,
  });

  const flamechart: Flamechart = speedscopeFlamechart.getLayers().map(layer =>
    layer.map(({start, end, node: {frame: {name, file, line, col}}}) => ({
      name,
      timestamp: start / 1000,
      duration: (end - start) / 1000,
      scriptUrl: file,
      locationLine: line,
      locationColumn: col,
    })),
  );

  return flamechart;
}

export default function preprocessData(
  timeline: TimelineEvent[],
): ReactProfilerData {
  const flamechart = preprocessFlamechart(timeline);

  const laneToReactMeasureMap = new Map();
  for (let lane: ReactLane = 0; lane < REACT_TOTAL_NUM_LANES; lane++) {
    laneToReactMeasureMap.set(lane, []);
  }

  const profilerData: ReactProfilerData = {
    batchUIDToMeasuresMap: new Map(),
    componentMeasures: [],
    duration: 0,
    flamechart,
    laneToLabelMap: new Map(),
    laneToReactMeasureMap,
    nativeEvents: [],
    otherUserTimingMarks: [],
    reactVersion: null,
    schedulingEvents: [],
    startTime: 0,
    suspenseEvents: [],
  };

  // Sort `timeline`. JSON Array Format trace events need not be ordered. See:
  // https://docs.google.com/document/d/1CvAClvFfyA5R-PhYUmn5OOQtYMH4h6I0nSsKchNAySU/preview#heading=h.f2f0yd51wi15
  timeline = timeline.filter(Boolean).sort((a, b) => (a.ts > b.ts ? 1 : -1));

  // Events displayed in flamechart have timestamps relative to the profile
  // event's startTime. Source: https://github.com/v8/v8/blob/44bd8fd7/src/inspector/js_protocol.json#L1486
  //
  // We'll thus expect there to be a 'Profile' event; if there is not one, we
  // can deduce that there are no flame chart events. As we expect React
  // scheduling profiling user timing marks to be recorded together with browser
  // flame chart events, we can futher deduce that the data is invalid and we
  // don't bother finding React events.
  const indexOfProfileEvent = timeline.findIndex(
    event => event.name === 'Profile',
  );
  if (indexOfProfileEvent === -1) {
    return profilerData;
  }

  // Use Profile event's `startTime` as the start time to align with flame chart.
  // TODO: Remove assumption that there'll only be 1 'Profile' event. If this
  // assumption does not hold, the chart may start at the wrong time.
  profilerData.startTime = timeline[indexOfProfileEvent].args.data.startTime;
  profilerData.duration =
    (timeline[timeline.length - 1].ts - profilerData.startTime) / 1000;

  const state: ProcessorState = {
    batchUID: 0,
    currentReactComponentMeasure: null,
    measureStack: [],
    nativeEventStack: [],
    nextRenderShouldGenerateNewBatchID: true,
    potentialLongEvents: [],
    potentialLongNestedUpdate: null,
    potentialLongNestedUpdates: [],
    potentialSuspenseEventsOutsideOfTransition: [],
    uidCounter: 0,
    unresolvedSuspenseEvents: new Map(),
  };

  timeline.forEach(event => processTimelineEvent(event, profilerData, state));

  if (profilerVersion === null) {
    throw new InvalidProfileError(
      `This version of profiling data is not supported by the current profiler.`,
    );
  }

  // Validate that all events and measures are complete
  const {measureStack} = state;
  if (measureStack.length > 0) {
    console.error('Incomplete events or measures', measureStack);
  }

  // Check for warnings.
  state.potentialLongEvents.forEach(([nativeEvent, batchUID]) => {
    // See how long the subsequent batch of React work was.
    // Ignore any work that was already started.
    const [startTime, stopTime] = getBatchRange(
      batchUID,
      profilerData,
      nativeEvent.timestamp,
    );
    if (stopTime - startTime > NATIVE_EVENT_DURATION_THRESHOLD) {
      nativeEvent.warning = WARNING_STRINGS.LONG_EVENT_HANDLER;
    }
  });
  state.potentialLongNestedUpdates.forEach(([schedulingEvent, batchUID]) => {
    // See how long the subsequent batch of React work was.
    const [startTime, stopTime] = getBatchRange(batchUID, profilerData);
    if (stopTime - startTime > NESTED_UPDATE_DURATION_THRESHOLD) {
      schedulingEvent.warning = WARNING_STRINGS.NESTED_UPDATE;
    }
  });
  state.potentialSuspenseEventsOutsideOfTransition.forEach(
    ([suspenseEvent, lanes]) => {
      // HACK This is a bit gross but the numeric lane value might change between render versions.
      if (
        !lanes.some(
          lane => profilerData.laneToLabelMap.get(lane) === 'Transition',
        )
      ) {
        suspenseEvent.warning = WARNING_STRINGS.SUSPEND_DURING_UPATE;
      }
    },
  );

  return profilerData;
}
