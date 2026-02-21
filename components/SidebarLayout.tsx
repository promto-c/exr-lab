import React from 'react';

type MobilePaneSize = 'auto' | 'fill' | number | string;

export interface SidebarPane {
  id: string;
  /** element to render inside the pane. When a valid React element is provided the layout
   *  will automatically inject `collapsed` and `onCollapsedChange` props so that the pane
   *  can be controlled. This allows callers to omit those props and keep the collapse logic
   *  within the layout component.
   */
  content: React.ReactNode;
  initialRatio?: number;
  minSize?: number;
  /** if present, the pane becomes "controlled"; layout will respect this value rather
   *  than managing its own state. In uncontrolled mode the layout keeps track of the
   *  collapse state internally and applies mobile defaults (first pane expanded).
   */
  collapsed?: boolean;
  /** callback invoked when collapse state changes. Called by layout in both controlled
   *  and uncontrolled scenarios so that parent components may react if they wish.
   */
  onCollapsedChange?: (collapsed: boolean) => void;
  collapsedSize?: number;
  className?: string;
}

interface SidebarLayoutProps {
  header?: React.ReactNode;
  panes: SidebarPane[];
  isMobile: boolean;
  className?: string;
  splitterSize?: number;
}

// Hook to manage exclusive panel collapse on mobile
//
// This helper was originally used by the app to keep only a single pane expanded
// at a time.  SidebarLayout now implements that behaviour internally, so callers
// shouldn't need this anymore.  It remains exported for backwards compatibility
// or for consumers that render multiple layouts independently.
export const useMobileExclusiveCollapse = (
  panels: Array<{ id: string; setState: (collapsed: boolean) => void }>,
  isMobile: boolean
) => {
  return React.useCallback(
    (panelId: string, collapsed: boolean) => {
      const panel = panels.find((p) => p.id === panelId);
      if (!panel) return;

      if (isMobile && !collapsed) {
        // Expanding on mobile: collapse all others
        panels.forEach((p) => {
          if (p.id !== panelId) {
            p.setState(true);
          }
        });
      }
      // Always apply the change for the clicked panel
      panel.setState(collapsed);
    },
    [panels, isMobile]
  );
};

type DragState = {
  pointerId: number;
  splitterIndex: number;
  startY: number;
  startRatios: number[];
  availableHeight: number;
};

const DEFAULT_MIN_PANE_SIZE = 120;
const DEFAULT_SPLITTER_SIZE = 4;
const DEFAULT_COLLAPSED_PANE_SIZE = 44;

const cx = (...classes: Array<string | false | null | undefined>): string =>
  classes.filter(Boolean).join(' ');

const normalizeRatios = (values: number[]): number[] => {
  if (values.length === 0) return [];
  const safe = values.map((value) => (Number.isFinite(value) && value > 0 ? value : 0));
  const sum = safe.reduce((acc, value) => acc + value, 0);
  if (sum <= 0) return safe.map(() => 1 / safe.length);
  return safe.map((value) => value / sum);
};

const buildInitialRatios = (panes: SidebarPane[]): number[] =>
  normalizeRatios(panes.map((pane) => pane.initialRatio ?? 1));

const remapRatios = (
  nextPanes: SidebarPane[],
  previousPanes: SidebarPane[],
  previousRatios: number[]
): number[] => {
  const previousById = new Map<string, number>();
  previousPanes.forEach((pane, index) => {
    previousById.set(pane.id, previousRatios[index] ?? 0);
  });

  return normalizeRatios(
    nextPanes.map((pane) => previousById.get(pane.id) ?? pane.initialRatio ?? 1)
  );
};

const toCssLength = (value: number | string): string =>
  typeof value === 'number' ? `${value}px` : value;

const getCollapsedPaneSize = (pane: SidebarPane): number =>
  pane.collapsedSize ?? DEFAULT_COLLAPSED_PANE_SIZE;

export const SidebarLayout: React.FC<SidebarLayoutProps> = ({
  header,
  panes,
  isMobile,
  className,
  splitterSize = DEFAULT_SPLITTER_SIZE,
}) => {
  const bodyRef = React.useRef<HTMLDivElement>(null);
  const dragStateRef = React.useRef<DragState | null>(null);
  const previousPanesRef = React.useRef<SidebarPane[]>(panes);

  // collapse state for uncontrolled panes
  const [internalCollapsed, setInternalCollapsed] = React.useState<Record<string, boolean>>(() => {
    const map: Record<string, boolean> = {};
    panes.forEach((p) => {
      map[p.id] = p.collapsed ?? false;
    });
    return map;
  });
  const prevIsMobileRef = React.useRef(isMobile);

  const [ratios, setRatios] = React.useState<number[]>(() => buildInitialRatios(panes));
  const [activeSplitterIndex, setActiveSplitterIndex] = React.useState<number | null>(null);

  const paneSignature = panes.map((pane) => pane.id).join('|');

  React.useEffect(() => {
    setRatios((previousRatios) => remapRatios(panes, previousPanesRef.current, previousRatios));
    previousPanesRef.current = panes;

    // keep internal collapse map in step with the list of panes.  When a pane is
    // controlled (pane.collapsed !== undefined) we simply reflect that value;
    // otherwise preserve the previous state or default to expanded.
    setInternalCollapsed((prev) => {
      const next: Record<string, boolean> = {};
      panes.forEach((p) => {
        if (p.collapsed !== undefined) {
          next[p.id] = p.collapsed;
        } else if (p.id in prev) {
          next[p.id] = prev[p.id];
        } else {
          next[p.id] = false;
        }
      });

      if (
        isMobile &&
        (prevIsMobileRef.current !== isMobile || Object.values(prev).every((v) => !v))
      ) {
        // entering mobile mode or initial mobile mount with all expanded: collapse all
        // except the first pane in the array.
        const firstId = panes[0]?.id;
        panes.forEach((p) => {
          next[p.id] = p.id !== firstId;
        });
      }

      prevIsMobileRef.current = isMobile;
      return next;
    });
  }, [paneSignature, isMobile]);

  React.useEffect(() => {
    if (activeSplitterIndex === null) return;

    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    return () => {
      document.body.style.cursor = 'default';
      document.body.style.userSelect = 'auto';
    };
  }, [activeSplitterIndex]);

  const endResize = React.useCallback(() => {
    dragStateRef.current = null;
    setActiveSplitterIndex(null);
  }, []);

  const canResizeSplitter = React.useCallback(
    (splitterIndex: number) => {
      const current = panes[splitterIndex];
      const next = panes[splitterIndex + 1];
      if (!current || !next) return false;
      const currentCollapsed =
        current.collapsed !== undefined ? current.collapsed : internalCollapsed[current.id];
      const nextCollapsed =
        next.collapsed !== undefined ? next.collapsed : internalCollapsed[next.id];
      return !currentCollapsed && !nextCollapsed;
    },
    [panes, internalCollapsed]
  );

  const handleSplitterPointerMove = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const dragState = dragStateRef.current;
      if (!dragState || dragState.pointerId !== event.pointerId) return;
      if (dragState.startRatios.length !== panes.length) return;

      const index = dragState.splitterIndex;
      if (!panes[index] || !panes[index + 1]) return;
      if (!canResizeSplitter(index)) return;

      const deltaRatio = (event.clientY - dragState.startY) / dragState.availableHeight;
      const pairTotal = dragState.startRatios[index] + dragState.startRatios[index + 1];

      const minCurrent = (panes[index].minSize ?? DEFAULT_MIN_PANE_SIZE) / dragState.availableHeight;
      const minNext = (panes[index + 1].minSize ?? DEFAULT_MIN_PANE_SIZE) / dragState.availableHeight;

      const minCurrentRatio = Math.min(minCurrent, pairTotal);
      const minNextRatio = Math.min(minNext, pairTotal);
      const maxCurrentRatio = Math.max(pairTotal - minNextRatio, minCurrentRatio);

      const nextCurrentRatio = Math.min(
        Math.max(dragState.startRatios[index] + deltaRatio, minCurrentRatio),
        maxCurrentRatio
      );
      const nextNeighborRatio = pairTotal - nextCurrentRatio;

      const nextRatios = [...dragState.startRatios];
      nextRatios[index] = nextCurrentRatio;
      nextRatios[index + 1] = nextNeighborRatio;
      setRatios(normalizeRatios(nextRatios));
    },
    [canResizeSplitter, panes]
  );

  const startResize =
    (splitterIndex: number) => (event: React.PointerEvent<HTMLDivElement>) => {
      if (isMobile || panes.length < 2) return;
      if (!canResizeSplitter(splitterIndex)) return;
      if (event.pointerType !== 'touch' && event.button !== 0) return;

      const container = bodyRef.current;
      if (!container) return;

      const collapsedHeight = panes.reduce((sum, pane) => {
        const paneCollapsed =
          pane.collapsed !== undefined ? pane.collapsed : internalCollapsed[pane.id];
        if (!paneCollapsed) return sum;
        return sum + getCollapsedPaneSize(pane);
      }, 0);

      const availableHeight = Math.max(
        container.getBoundingClientRect().height - splitterSize * (panes.length - 1) - collapsedHeight,
        1
      );

      dragStateRef.current = {
        pointerId: event.pointerId,
        splitterIndex,
        startY: event.clientY,
        startRatios: ratios,
        availableHeight,
      };
      setActiveSplitterIndex(splitterIndex);
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
    };

  const desktopTemplateRows = React.useMemo(() => {
    if (panes.length === 0) return '';
    const paneRatios = ratios.length === panes.length ? ratios : buildInitialRatios(panes);
    const expandedIndexes = panes
      .map((pane, index) => {
        const paneCollapsed =
          pane.collapsed !== undefined ? pane.collapsed : internalCollapsed[pane.id];
        return !paneCollapsed ? index : -1;
      })
      .filter((index) => index >= 0);
    const expandedRatioSum = expandedIndexes.reduce(
      (sum, index) => sum + Math.max(paneRatios[index] ?? 0, 0),
      0
    );
    const rows: string[] = [];
    panes.forEach((pane, index) => {
      const paneCollapsed =
        pane.collapsed !== undefined ? pane.collapsed : internalCollapsed[pane.id];
      if (paneCollapsed) {
        rows.push(`${getCollapsedPaneSize(pane)}px`);
      } else {
        const normalizedRatio =
          expandedRatioSum > 0
            ? Math.max(paneRatios[index] ?? 0, 0) / expandedRatioSum
            : 1 / Math.max(expandedIndexes.length, 1);
        rows.push(`${Math.max(normalizedRatio, 0.0001)}fr`);
      }
      if (index < panes.length - 1) rows.push(`${splitterSize}px`);
    });
    return rows.join(' ');
  }, [panes, ratios, splitterSize, internalCollapsed]);

  const handlePaneCollapsedChange = (paneId: string, collapsed: boolean) => {
    setInternalCollapsed((prev) => {
      const next = { ...prev };
      if (isMobile && !collapsed) {
        // expanding, collapse others
        Object.keys(next).forEach((id) => {
          if (id !== paneId) next[id] = true;
        });
      }
      next[paneId] = collapsed;
      return next;
    });

    const pane = panes.find((p) => p.id === paneId);
    pane?.onCollapsedChange?.(collapsed);
  };

  const renderPane = (pane: SidebarPane) => {
    const style: React.CSSProperties = {};
    const baseClasses = 'overflow-hidden flex flex-col min-h-0';
    const paneCollapsed =
      pane.collapsed !== undefined ? pane.collapsed : internalCollapsed[pane.id];
    const onChange = (next: boolean) => handlePaneCollapsedChange(pane.id, next);

    const content =
      React.isValidElement(pane.content) && pane.collapsed === undefined
        ? React.cloneElement(pane.content, { collapsed: paneCollapsed, onCollapsedChange: onChange })
        : pane.content;

    // on mobile, collapsed panes should size to their natural height (header
    // only), and the single expanded pane should flex to fill the remaining
    // space so that its internal scrollbars work.  On desktop the grid
    // layout takes care of sizing.
    const mobileFlexClass = isMobile
      ? paneCollapsed
        ? 'flex-[0_0_auto]'
        : 'flex-1'
      : '';

    return (
      <div key={pane.id} className={cx(baseClasses, mobileFlexClass, pane.className)} style={style}>
        {content}
      </div>
    );
  };

  return (
    <div className={cx('h-full flex flex-col', className)}>
      {header}

      <div
        ref={bodyRef}
        className={cx(
          'flex-1 min-h-0',
          isMobile ? 'flex flex-col overflow-y-auto' : 'grid'
        )}
        style={isMobile ? undefined : { gridTemplateRows: desktopTemplateRows }}
      >
        {panes.map((pane, index) => {

          const paneElement = renderPane(pane);

          if (isMobile) {
            return paneElement;
          }

          // desktop: include splitters between panes
          return (
            <React.Fragment key={pane.id}>
              {paneElement}
              {index < panes.length - 1 && (
                <div
                  className={cx(
                    'border-y border-neutral-800/50 flex items-center justify-center transition-colors shrink-0 z-20',
                    canResizeSplitter(index)
                      ? cx(
                          'bg-neutral-950 cursor-row-resize',
                          activeSplitterIndex === index ? 'bg-teal-500' : 'hover:bg-teal-500'
                        )
                      : 'bg-neutral-900/60 cursor-default'
                  )}
                  style={{ height: `${splitterSize}px` }}
                  onPointerDown={canResizeSplitter(index) ? startResize(index) : undefined}
                  onPointerMove={canResizeSplitter(index) ? handleSplitterPointerMove : undefined}
                  onPointerUp={canResizeSplitter(index) ? endResize : undefined}
                  onPointerCancel={canResizeSplitter(index) ? endResize : undefined}
                  onLostPointerCapture={canResizeSplitter(index) ? endResize : undefined}
                >
                  <div className="w-12 h-0.5 bg-neutral-700/50 rounded-full pointer-events-none" />
                </div>
              )}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
};
