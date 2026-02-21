import React from 'react';

type MobilePaneSize = 'auto' | 'fill' | number | string;

export interface SidebarPane {
  id: string;
  content: React.ReactNode;
  initialRatio?: number;
  minSize?: number;
  collapsed?: boolean;
  collapsedSize?: number;
  mobileSize?: MobilePaneSize;
  className?: string;
}

interface SidebarLayoutProps {
  header?: React.ReactNode;
  panes: SidebarPane[];
  isMobile: boolean;
  className?: string;
  splitterSize?: number;
}

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

  const [ratios, setRatios] = React.useState<number[]>(() => buildInitialRatios(panes));
  const [activeSplitterIndex, setActiveSplitterIndex] = React.useState<number | null>(null);

  const paneSignature = panes.map((pane) => pane.id).join('|');

  React.useEffect(() => {
    setRatios((previousRatios) => remapRatios(panes, previousPanesRef.current, previousRatios));
    previousPanesRef.current = panes;
  }, [paneSignature]);

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
      return !current.collapsed && !next.collapsed;
    },
    [panes]
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
        if (!pane.collapsed) return sum;
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
      .map((pane, index) => (!pane.collapsed ? index : -1))
      .filter((index) => index >= 0);
    const expandedRatioSum = expandedIndexes.reduce(
      (sum, index) => sum + Math.max(paneRatios[index] ?? 0, 0),
      0
    );
    const rows: string[] = [];
    panes.forEach((pane, index) => {
      if (pane.collapsed) {
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
  }, [panes, ratios, splitterSize]);

  const renderMobilePane = (pane: SidebarPane) => {
    const mobileSize = pane.mobileSize ?? 'auto';
    const style: React.CSSProperties = {};
    const baseClasses = 'overflow-hidden flex flex-col min-h-0';

    if (mobileSize === 'fill') {
      return (
        <div key={pane.id} className={cx(baseClasses, 'flex-1', pane.className)}>
          {pane.content}
        </div>
      );
    }

    if (mobileSize !== 'auto') {
      style.height = toCssLength(mobileSize);
    }

    return (
      <div key={pane.id} className={cx(baseClasses, 'shrink-0', pane.className)} style={style}>
        {pane.content}
      </div>
    );
  };

  return (
    <div className={cx('h-full flex flex-col', className)}>
      {header}

      <div
        ref={bodyRef}
        className={cx('flex-1 min-h-0', isMobile ? 'flex flex-col' : 'grid')}
        style={isMobile ? undefined : { gridTemplateRows: desktopTemplateRows }}
      >
        {isMobile
          ? panes.map(renderMobilePane)
          : panes.map((pane, index) => (
              <React.Fragment key={pane.id}>
                <div className={cx('overflow-hidden flex flex-col min-h-0', pane.className)}>
                  {pane.content}
                </div>
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
            ))}
      </div>
    </div>
  );
};
