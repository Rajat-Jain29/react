/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {Point} from './view-base';
import type {
  ReactHoverContextInfo,
  ReactProfilerData,
  ReactMeasure,
  ViewState,
} from './types';

import * as React from 'react';
import {
  Fragment,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useCallback,
} from 'react';
import AutoSizer from 'react-virtualized-auto-sizer';
import {copy} from 'clipboard-js';
import prettyMilliseconds from 'pretty-ms';

import {
  BackgroundColorView,
  HorizontalPanAndZoomView,
  ResizableView,
  Surface,
  VerticalScrollView,
  View,
  createComposedLayout,
  lastViewTakesUpRemainingSpaceLayout,
  useCanvasInteraction,
  verticallyStackedLayout,
  zeroPoint,
} from './view-base';
import {
  ComponentMeasuresView,
  FlamechartView,
  NativeEventsView,
  ReactMeasuresView,
  SchedulingEventsView,
  SuspenseEventsView,
  TimeAxisMarkersView,
  UserTimingMarksView,
} from './content-views';
import {COLORS} from './content-views/constants';
import {clampState, moveStateToRange} from './view-base/utils/scrollState';
import EventTooltip from './EventTooltip';
import {RegistryContext} from 'react-devtools-shared/src/devtools/ContextMenu/Contexts';
import ContextMenu from 'react-devtools-shared/src/devtools/ContextMenu/ContextMenu';
import ContextMenuItem from 'react-devtools-shared/src/devtools/ContextMenu/ContextMenuItem';
import useContextMenu from 'react-devtools-shared/src/devtools/ContextMenu/useContextMenu';
import {getBatchRange} from './utils/getBatchRange';
import {MAX_ZOOM_LEVEL, MIN_ZOOM_LEVEL} from './view-base/constants';

import styles from './CanvasPage.css';

const CONTEXT_MENU_ID = 'canvas';

type Props = {|
  profilerData: ReactProfilerData,
  viewState: ViewState,
|};

function CanvasPage({profilerData, viewState}: Props) {
  return (
    <div
      className={styles.CanvasPage}
      style={{backgroundColor: COLORS.BACKGROUND}}>
      <AutoSizer>
        {({height, width}: {height: number, width: number}) => (
          <AutoSizedCanvas
            data={profilerData}
            height={height}
            viewState={viewState}
            width={width}
          />
        )}
      </AutoSizer>
    </div>
  );
}

const copySummary = (data: ReactProfilerData, measure: ReactMeasure) => {
  const {batchUID, duration, timestamp, type} = measure;

  const [startTime, stopTime] = getBatchRange(batchUID, data);

  copy(
    JSON.stringify({
      type,
      timestamp: prettyMilliseconds(timestamp),
      duration: prettyMilliseconds(duration),
      batchDuration: prettyMilliseconds(stopTime - startTime),
    }),
  );
};

const zoomToBatch = (
  data: ReactProfilerData,
  measure: ReactMeasure,
  viewState: ViewState,
  width: number,
) => {
  const {batchUID} = measure;
  const [rangeStart, rangeEnd] = getBatchRange(batchUID, data);

  // Convert from time range to ScrollState
  const scrollState = moveStateToRange({
    state: viewState.horizontalScrollState,
    rangeStart,
    rangeEnd,
    contentLength: data.duration,

    minContentLength: data.duration * MIN_ZOOM_LEVEL,
    maxContentLength: data.duration * MAX_ZOOM_LEVEL,
    containerLength: width,
  });

  viewState.updateHorizontalScrollState(scrollState);
};

type AutoSizedCanvasProps = {|
  data: ReactProfilerData,
  height: number,
  viewState: ViewState,
  width: number,
|};

function AutoSizedCanvas({
  data,
  height,
  viewState,
  width,
}: AutoSizedCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const [isContextMenuShown, setIsContextMenuShown] = useState<boolean>(false);
  const [mouseLocation, setMouseLocation] = useState<Point>(zeroPoint); // DOM coordinates
  const [
    hoveredEvent,
    setHoveredEvent,
  ] = useState<ReactHoverContextInfo | null>(null);

  const surfaceRef = useRef(new Surface());
  const userTimingMarksViewRef = useRef(null);
  const nativeEventsViewRef = useRef(null);
  const schedulingEventsViewRef = useRef(null);
  const suspenseEventsViewRef = useRef(null);
  const componentMeasuresViewRef = useRef(null);
  const reactMeasuresViewRef = useRef(null);
  const flamechartViewRef = useRef(null);

  const {hideMenu: hideContextMenu} = useContext(RegistryContext);

  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    const defaultFrame = {origin: zeroPoint, size: {width, height}};

    // Auto hide context menu when panning.
    viewState.onHorizontalScrollStateChange(scrollState => {
      hideContextMenu();
    });

    // Initialize horizontal view state
    viewState.updateHorizontalScrollState(
      clampState({
        state: viewState.horizontalScrollState,
        minContentLength: data.duration * MIN_ZOOM_LEVEL,
        maxContentLength: data.duration * MAX_ZOOM_LEVEL,
        containerLength: defaultFrame.size.width,
      }),
    );

    function createViewHelper(
      view: View,
      label: string,
      shouldScrollVertically: boolean = false,
      shouldResizeVertically: boolean = false,
    ): View {
      let verticalScrollView = null;
      if (shouldScrollVertically) {
        verticalScrollView = new VerticalScrollView(
          surface,
          defaultFrame,
          view,
          viewState,
          label,
        );
      }

      const horizontalPanAndZoomView = new HorizontalPanAndZoomView(
        surface,
        defaultFrame,
        verticalScrollView !== null ? verticalScrollView : view,
        data.duration,
        viewState,
      );

      let resizableView = null;
      if (shouldResizeVertically) {
        resizableView = new ResizableView(
          surface,
          defaultFrame,
          horizontalPanAndZoomView,
          viewState,
          canvasRef,
          label,
        );
      }

      return resizableView || horizontalPanAndZoomView;
    }

    const axisMarkersView = new TimeAxisMarkersView(
      surface,
      defaultFrame,
      data.duration,
    );
    const axisMarkersViewWrapper = createViewHelper(axisMarkersView, 'time');

    let userTimingMarksViewWrapper = null;
    if (data.otherUserTimingMarks.length > 0) {
      const userTimingMarksView = new UserTimingMarksView(
        surface,
        defaultFrame,
        data.otherUserTimingMarks,
        data.duration,
      );
      userTimingMarksViewRef.current = userTimingMarksView;
      userTimingMarksViewWrapper = createViewHelper(
        userTimingMarksView,
        'user timing api',
      );
    }

    const nativeEventsView = new NativeEventsView(surface, defaultFrame, data);
    nativeEventsViewRef.current = nativeEventsView;
    const nativeEventsViewWrapper = createViewHelper(
      nativeEventsView,
      'events',
      true,
      true,
    );

    const schedulingEventsView = new SchedulingEventsView(
      surface,
      defaultFrame,
      data,
    );
    schedulingEventsViewRef.current = schedulingEventsView;
    const schedulingEventsViewWrapper = createViewHelper(
      schedulingEventsView,
      'react updates',
    );

    let suspenseEventsViewWrapper = null;
    if (data.suspenseEvents.length > 0) {
      const suspenseEventsView = new SuspenseEventsView(
        surface,
        defaultFrame,
        data,
      );
      suspenseEventsViewRef.current = suspenseEventsView;
      suspenseEventsViewWrapper = createViewHelper(
        suspenseEventsView,
        'suspense',
        true,
        true,
      );
    }

    const reactMeasuresView = new ReactMeasuresView(
      surface,
      defaultFrame,
      data,
    );
    reactMeasuresViewRef.current = reactMeasuresView;
    const reactMeasuresViewWrapper = createViewHelper(
      reactMeasuresView,
      'react scheduling',
      true,
      true,
    );

    let componentMeasuresViewWrapper = null;
    if (data.componentMeasures.length > 0) {
      const componentMeasuresView = new ComponentMeasuresView(
        surface,
        defaultFrame,
        data,
      );
      componentMeasuresViewRef.current = componentMeasuresView;
      componentMeasuresViewWrapper = createViewHelper(
        componentMeasuresView,
        'react components',
      );
    }

    const flamechartView = new FlamechartView(
      surface,
      defaultFrame,
      data.flamechart,
      data.duration,
    );
    flamechartViewRef.current = flamechartView;
    const flamechartViewWrapper = createViewHelper(
      flamechartView,
      'flamechart',
      true,
      true,
    );

    // Root view contains all of the sub views defined above.
    // The order we add them below determines their vertical position.
    const rootView = new View(
      surface,
      defaultFrame,
      createComposedLayout(
        verticallyStackedLayout,
        lastViewTakesUpRemainingSpaceLayout,
      ),
    );
    rootView.addSubview(axisMarkersViewWrapper);
    if (userTimingMarksViewWrapper !== null) {
      rootView.addSubview(userTimingMarksViewWrapper);
    }
    rootView.addSubview(nativeEventsViewWrapper);
    rootView.addSubview(schedulingEventsViewWrapper);
    if (suspenseEventsViewWrapper !== null) {
      rootView.addSubview(suspenseEventsViewWrapper);
    }
    rootView.addSubview(reactMeasuresViewWrapper);
    if (componentMeasuresViewWrapper !== null) {
      rootView.addSubview(componentMeasuresViewWrapper);
    }
    rootView.addSubview(flamechartViewWrapper);

    // If subviews are less than the available height, fill remaining height with a solid color.
    rootView.addSubview(new BackgroundColorView(surface, defaultFrame));

    surfaceRef.current.rootView = rootView;
  }, [data]);

  useLayoutEffect(() => {
    if (canvasRef.current) {
      surfaceRef.current.setCanvas(canvasRef.current, {width, height});
    }
  }, [width, height]);

  const interactor = useCallback(interaction => {
    const canvas = canvasRef.current;
    if (canvas === null) {
      return;
    }

    // Wheel events should always hide the current tooltip.
    switch (interaction.type) {
      case 'wheel-control':
      case 'wheel-meta':
      case 'wheel-plain':
      case 'wheel-shift':
        setHoveredEvent(prevHoverEvent => {
          if (prevHoverEvent === null) {
            return prevHoverEvent;
          } else if (
            prevHoverEvent.componentMeasure !== null ||
            prevHoverEvent.flamechartStackFrame !== null ||
            prevHoverEvent.measure !== null ||
            prevHoverEvent.nativeEvent !== null ||
            prevHoverEvent.schedulingEvent !== null ||
            prevHoverEvent.suspenseEvent !== null ||
            prevHoverEvent.userTimingMark !== null
          ) {
            return {
              componentMeasure: null,
              data: prevHoverEvent.data,
              flamechartStackFrame: null,
              measure: null,
              nativeEvent: null,
              schedulingEvent: null,
              suspenseEvent: null,
              userTimingMark: null,
            };
          } else {
            return prevHoverEvent;
          }
        });
        break;
    }

    const surface = surfaceRef.current;
    surface.handleInteraction(interaction);

    canvas.style.cursor = surface.getCurrentCursor() || 'default';

    // Defer drawing to canvas until React's commit phase, to avoid drawing
    // twice and to ensure that both the canvas and DOM elements managed by
    // React are in sync.
    setMouseLocation({
      x: interaction.payload.event.x,
      y: interaction.payload.event.y,
    });
  }, []);

  useCanvasInteraction(canvasRef, interactor);

  useContextMenu({
    data: {
      data,
      hoveredEvent,
    },
    id: CONTEXT_MENU_ID,
    onChange: setIsContextMenuShown,
    ref: canvasRef,
  });

  useEffect(() => {
    const {current: userTimingMarksView} = userTimingMarksViewRef;
    if (userTimingMarksView) {
      userTimingMarksView.onHover = userTimingMark => {
        if (!hoveredEvent || hoveredEvent.userTimingMark !== userTimingMark) {
          setHoveredEvent({
            componentMeasure: null,
            data,
            flamechartStackFrame: null,
            measure: null,
            nativeEvent: null,
            schedulingEvent: null,
            suspenseEvent: null,
            userTimingMark,
          });
        }
      };
    }

    const {current: nativeEventsView} = nativeEventsViewRef;
    if (nativeEventsView) {
      nativeEventsView.onHover = nativeEvent => {
        if (!hoveredEvent || hoveredEvent.nativeEvent !== nativeEvent) {
          setHoveredEvent({
            componentMeasure: null,
            data,
            flamechartStackFrame: null,
            measure: null,
            nativeEvent,
            schedulingEvent: null,
            suspenseEvent: null,
            userTimingMark: null,
          });
        }
      };
    }

    const {current: schedulingEventsView} = schedulingEventsViewRef;
    if (schedulingEventsView) {
      schedulingEventsView.onHover = schedulingEvent => {
        if (!hoveredEvent || hoveredEvent.schedulingEvent !== schedulingEvent) {
          setHoveredEvent({
            componentMeasure: null,
            data,
            flamechartStackFrame: null,
            measure: null,
            nativeEvent: null,
            schedulingEvent,
            suspenseEvent: null,
            userTimingMark: null,
          });
        }
      };
    }

    const {current: suspenseEventsView} = suspenseEventsViewRef;
    if (suspenseEventsView) {
      suspenseEventsView.onHover = suspenseEvent => {
        if (!hoveredEvent || hoveredEvent.suspenseEvent !== suspenseEvent) {
          setHoveredEvent({
            componentMeasure: null,
            data,
            flamechartStackFrame: null,
            measure: null,
            nativeEvent: null,
            schedulingEvent: null,
            suspenseEvent,
            userTimingMark: null,
          });
        }
      };
    }

    const {current: reactMeasuresView} = reactMeasuresViewRef;
    if (reactMeasuresView) {
      reactMeasuresView.onHover = measure => {
        if (!hoveredEvent || hoveredEvent.measure !== measure) {
          setHoveredEvent({
            componentMeasure: null,
            data,
            flamechartStackFrame: null,
            measure,
            nativeEvent: null,
            schedulingEvent: null,
            suspenseEvent: null,
            userTimingMark: null,
          });
        }
      };
    }

    const {current: componentMeasuresView} = componentMeasuresViewRef;
    if (componentMeasuresView) {
      componentMeasuresView.onHover = componentMeasure => {
        if (
          !hoveredEvent ||
          hoveredEvent.componentMeasure !== componentMeasure
        ) {
          setHoveredEvent({
            componentMeasure,
            data,
            flamechartStackFrame: null,
            measure: null,
            nativeEvent: null,
            schedulingEvent: null,
            suspenseEvent: null,
            userTimingMark: null,
          });
        }
      };
    }

    const {current: flamechartView} = flamechartViewRef;
    if (flamechartView) {
      flamechartView.setOnHover(flamechartStackFrame => {
        if (
          !hoveredEvent ||
          hoveredEvent.flamechartStackFrame !== flamechartStackFrame
        ) {
          setHoveredEvent({
            componentMeasure: null,
            data,
            flamechartStackFrame,
            measure: null,
            nativeEvent: null,
            schedulingEvent: null,
            suspenseEvent: null,
            userTimingMark: null,
          });
        }
      });
    }
  }, [
    hoveredEvent,
    data, // Attach onHover callbacks when views are re-created on data change
  ]);

  useLayoutEffect(() => {
    const {current: userTimingMarksView} = userTimingMarksViewRef;
    if (userTimingMarksView) {
      userTimingMarksView.setHoveredMark(
        hoveredEvent ? hoveredEvent.userTimingMark : null,
      );
    }

    const {current: nativeEventsView} = nativeEventsViewRef;
    if (nativeEventsView) {
      nativeEventsView.setHoveredEvent(
        hoveredEvent ? hoveredEvent.nativeEvent : null,
      );
    }

    const {current: schedulingEventsView} = schedulingEventsViewRef;
    if (schedulingEventsView) {
      schedulingEventsView.setHoveredEvent(
        hoveredEvent ? hoveredEvent.schedulingEvent : null,
      );
    }

    const {current: suspenseEventsView} = suspenseEventsViewRef;
    if (suspenseEventsView) {
      suspenseEventsView.setHoveredEvent(
        hoveredEvent ? hoveredEvent.suspenseEvent : null,
      );
    }

    const {current: reactMeasuresView} = reactMeasuresViewRef;
    if (reactMeasuresView) {
      reactMeasuresView.setHoveredMeasure(
        hoveredEvent ? hoveredEvent.measure : null,
      );
    }

    const {current: flamechartView} = flamechartViewRef;
    if (flamechartView) {
      flamechartView.setHoveredFlamechartStackFrame(
        hoveredEvent ? hoveredEvent.flamechartStackFrame : null,
      );
    }
  }, [hoveredEvent]);

  // Draw to canvas in React's commit phase
  useLayoutEffect(() => {
    surfaceRef.current.displayIfNeeded();
  });

  return (
    <Fragment>
      <canvas ref={canvasRef} height={height} width={width} />
      <ContextMenu id={CONTEXT_MENU_ID}>
        {contextData => {
          if (contextData.hoveredEvent == null) {
            return null;
          }
          const {
            componentMeasure,
            flamechartStackFrame,
            measure,
            schedulingEvent,
            suspenseEvent,
          } = contextData.hoveredEvent;
          return (
            <Fragment>
              {componentMeasure !== null && (
                <ContextMenuItem
                  onClick={() => copy(componentMeasure.componentName)}
                  title="Copy component name">
                  Copy component name
                </ContextMenuItem>
              )}
              {schedulingEvent !== null && (
                <ContextMenuItem
                  onClick={() => copy(schedulingEvent.componentName)}
                  title="Copy component name">
                  Copy component name
                </ContextMenuItem>
              )}
              {suspenseEvent !== null && (
                <ContextMenuItem
                  onClick={() => copy(suspenseEvent.componentName)}
                  title="Copy component name">
                  Copy component name
                </ContextMenuItem>
              )}
              {measure !== null && (
                <ContextMenuItem
                  onClick={() =>
                    zoomToBatch(contextData.data, measure, viewState, width)
                  }
                  title="Zoom to batch">
                  Zoom to batch
                </ContextMenuItem>
              )}
              {measure !== null && (
                <ContextMenuItem
                  onClick={() => copySummary(contextData.data, measure)}
                  title="Copy summary">
                  Copy summary
                </ContextMenuItem>
              )}
              {flamechartStackFrame !== null && (
                <ContextMenuItem
                  onClick={() => copy(flamechartStackFrame.scriptUrl)}
                  title="Copy file path">
                  Copy file path
                </ContextMenuItem>
              )}
              {flamechartStackFrame !== null && (
                <ContextMenuItem
                  onClick={() =>
                    copy(
                      `line ${flamechartStackFrame.locationLine ??
                        ''}, column ${flamechartStackFrame.locationColumn ??
                        ''}`,
                    )
                  }
                  title="Copy location">
                  Copy location
                </ContextMenuItem>
              )}
            </Fragment>
          );
        }}
      </ContextMenu>
      {!isContextMenuShown && !surfaceRef.current.hasActiveView() && (
        <EventTooltip
          canvasRef={canvasRef}
          data={data}
          hoveredEvent={hoveredEvent}
          origin={mouseLocation}
        />
      )}
    </Fragment>
  );
}

export default CanvasPage;
