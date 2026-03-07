import React from 'react';
import type { RawDecodeResult } from '../../services/render/types';

export type WindowRect = { x: number; y: number; width: number; height: number };
export type ViewTransform = { x: number; y: number; scale: number };

type UseViewportInteractionsParams = {
  canInteractWithViewport: boolean;
  isMobile: boolean;
  viewportReferenceRect: WindowRect | null;
  rawPixelData: RawDecodeResult | null;
  dataWindowRect: WindowRect | null;
  isInspectMode: boolean;
  isViewportUiTarget: (target: EventTarget | null) => boolean;
  containerRef: React.RefObject<HTMLDivElement | null>;
};

type UseViewportInteractionsResult = {
  viewTransform: ViewTransform;
  isDragging: boolean;
  inspectCursor: { x: number; y: number } | null;
  setInspectCursor: React.Dispatch<React.SetStateAction<{ x: number; y: number } | null>>;
  fitView: () => void;
  handleWheel: (event: React.WheelEvent) => void;
  handleMouseDown: (event: React.MouseEvent) => void;
  handleMouseMove: (event: React.MouseEvent) => void;
  handleMouseUp: () => void;
  handleMouseLeave: () => void;
  handleTouchStart: (event: React.TouchEvent) => void;
  handleTouchMove: (event: React.TouchEvent) => void;
  handleTouchEnd: (event: React.TouchEvent) => void;
};

const clampScale = (scale: number): number => {
  if (scale < 0.005) return 0.005;
  if (scale > 50) return 50;
  return scale;
};

export const useViewportInteractions = ({
  canInteractWithViewport,
  isMobile,
  viewportReferenceRect,
  rawPixelData,
  dataWindowRect,
  isInspectMode,
  isViewportUiTarget,
  containerRef,
}: UseViewportInteractionsParams): UseViewportInteractionsResult => {
  const [viewTransform, setViewTransform] = React.useState<ViewTransform>({ x: 0, y: 0, scale: 1 });
  const [isDragging, setIsDragging] = React.useState(false);
  const [dragStart, setDragStart] = React.useState({ x: 0, y: 0 });
  const [inspectCursor, setInspectCursor] = React.useState<{ x: number; y: number } | null>(null);

  const lastTouchRef = React.useRef<{ x: number; y: number }[] | null>(null);
  const isTouchUiInteractionRef = React.useRef(false);

  React.useEffect(() => {
    if (!canInteractWithViewport) return;

    const element = containerRef.current;
    if (!element) return;

    const preventDefault = (event: TouchEvent) => {
      if (event.type === 'touchstart') {
        isTouchUiInteractionRef.current = isViewportUiTarget(event.target);
      }

      if (isTouchUiInteractionRef.current || isViewportUiTarget(event.target)) return;
      event.preventDefault();
    };

    element.addEventListener('touchstart', preventDefault, { passive: false });
    element.addEventListener('touchmove', preventDefault, { passive: false });

    return () => {
      element.removeEventListener('touchstart', preventDefault);
      element.removeEventListener('touchmove', preventDefault);
    };
  }, [canInteractWithViewport, containerRef, isViewportUiTarget]);

  const fitView = React.useCallback(() => {
    if (!viewportReferenceRect || !containerRef.current) return;

    const { x: targetX, y: targetY, width, height } = viewportReferenceRect;
    const { clientWidth, clientHeight } = containerRef.current;

    const padding = isMobile ? 20 : 60;
    const availableWidth = clientWidth - padding;
    const availableHeight = clientHeight - padding;

    const scale = Math.min(availableWidth / width, availableHeight / height);
    const finalScale = scale > 0 ? scale : 1;

    const x = (clientWidth - width * finalScale) / 2 - targetX * finalScale;
    const y = (clientHeight - height * finalScale) / 2 - targetY * finalScale;

    setViewTransform({ x, y, scale: finalScale });
  }, [containerRef, isMobile, viewportReferenceRect]);

  const handleWheel = React.useCallback(
    (event: React.WheelEvent) => {
      if (!rawPixelData) return;
      if (!containerRef.current) return;

      const step = 1.1;
      const factor = event.deltaY < 0 ? step : 1 / step;
      const newScale = clampScale(viewTransform.scale * factor);
      const bounds = containerRef.current.getBoundingClientRect();
      const mouseX = event.clientX - bounds.left;
      const mouseY = event.clientY - bounds.top;

      const imageX = (mouseX - viewTransform.x) / viewTransform.scale;
      const imageY = (mouseY - viewTransform.y) / viewTransform.scale;
      const nextX = mouseX - imageX * newScale;
      const nextY = mouseY - imageY * newScale;

      setViewTransform({ x: nextX, y: nextY, scale: newScale });
    },
    [containerRef, rawPixelData, viewTransform],
  );

  const handleMouseDown = React.useCallback(
    (event: React.MouseEvent) => {
      if (event.button !== 0 && event.button !== 1) return;

      event.preventDefault();
      setIsDragging(true);
      setDragStart({
        x: event.clientX - viewTransform.x,
        y: event.clientY - viewTransform.y,
      });
    },
    [viewTransform],
  );

  const handleMouseMove = React.useCallback(
    (event: React.MouseEvent) => {
      if (isDragging) {
        event.preventDefault();
        setViewTransform((previous) => ({
          ...previous,
          x: event.clientX - dragStart.x,
          y: event.clientY - dragStart.y,
        }));
        return;
      }

      if (!isInspectMode || !rawPixelData || !containerRef.current || !dataWindowRect) return;

      const bounds = containerRef.current.getBoundingClientRect();
      const mouseX = event.clientX - bounds.left;
      const mouseY = event.clientY - bounds.top;

      const sceneX = (mouseX - viewTransform.x) / viewTransform.scale;
      const sceneY = (mouseY - viewTransform.y) / viewTransform.scale;
      const imageX = Math.floor(sceneX - dataWindowRect.x);
      const imageY = Math.floor(sceneY - dataWindowRect.y);

      if (
        imageX >= 0 &&
        imageX < rawPixelData.width &&
        imageY >= 0 &&
        imageY < rawPixelData.height
      ) {
        setInspectCursor({ x: imageX, y: imageY });
        return;
      }

      setInspectCursor(null);
    },
    [
      containerRef,
      dataWindowRect,
      dragStart,
      isDragging,
      isInspectMode,
      rawPixelData,
      viewTransform,
    ],
  );

  const handleMouseUp = React.useCallback(() => {
    setIsDragging(false);
  }, []);

  const handleMouseLeave = React.useCallback(() => {
    setIsDragging(false);
    setInspectCursor(null);
  }, []);

  const handleTouchStart = React.useCallback(
    (event: React.TouchEvent) => {
      if (isViewportUiTarget(event.target)) {
        setIsDragging(false);
        lastTouchRef.current = null;
        return;
      }

      if (event.touches.length === 1) {
        lastTouchRef.current = [{ x: event.touches[0].clientX, y: event.touches[0].clientY }];
        setIsDragging(true);
        return;
      }

      if (event.touches.length === 2) {
        const firstTouch = event.touches[0];
        const secondTouch = event.touches[1];
        lastTouchRef.current = [
          { x: firstTouch.clientX, y: firstTouch.clientY },
          { x: secondTouch.clientX, y: secondTouch.clientY },
        ];
        setIsDragging(false);
      }
    },
    [isViewportUiTarget],
  );

  const handleTouchMove = React.useCallback(
    (event: React.TouchEvent) => {
      if (isViewportUiTarget(event.target)) return;

      if (event.touches.length === 1 && lastTouchRef.current && lastTouchRef.current.length === 1) {
        const deltaX = event.touches[0].clientX - lastTouchRef.current[0].x;
        const deltaY = event.touches[0].clientY - lastTouchRef.current[0].y;

        setViewTransform((previous) => ({
          ...previous,
          x: previous.x + deltaX,
          y: previous.y + deltaY,
        }));

        lastTouchRef.current = [{ x: event.touches[0].clientX, y: event.touches[0].clientY }];
        return;
      }

      if (
        event.touches.length !== 2 ||
        !lastTouchRef.current ||
        lastTouchRef.current.length !== 2
      ) {
        return;
      }

      const previousFirst = lastTouchRef.current[0];
      const previousSecond = lastTouchRef.current[1];
      const firstTouch = event.touches[0];
      const secondTouch = event.touches[1];

      const previousDistance = Math.hypot(
        previousFirst.x - previousSecond.x,
        previousFirst.y - previousSecond.y,
      );
      const currentDistance = Math.hypot(
        firstTouch.clientX - secondTouch.clientX,
        firstTouch.clientY - secondTouch.clientY,
      );

      if (previousDistance > 0) {
        const scaleFactor = currentDistance / previousDistance;
        const previousCenterX = (previousFirst.x + previousSecond.x) / 2;
        const previousCenterY = (previousFirst.y + previousSecond.y) / 2;
        const currentCenterX = (firstTouch.clientX + secondTouch.clientX) / 2;
        const currentCenterY = (firstTouch.clientY + secondTouch.clientY) / 2;

        setViewTransform((previous) => {
          const bounds = containerRef.current?.getBoundingClientRect();
          if (!bounds) return previous;

          const newScale = clampScale(previous.scale * scaleFactor);
          const previousMouseX = previousCenterX - bounds.left;
          const previousMouseY = previousCenterY - bounds.top;
          const mouseX = currentCenterX - bounds.left;
          const mouseY = currentCenterY - bounds.top;

          const imageX = (previousMouseX - previous.x) / previous.scale;
          const imageY = (previousMouseY - previous.y) / previous.scale;

          return {
            x: mouseX - imageX * newScale,
            y: mouseY - imageY * newScale,
            scale: newScale,
          };
        });
      }

      lastTouchRef.current = [
        { x: firstTouch.clientX, y: firstTouch.clientY },
        { x: secondTouch.clientX, y: secondTouch.clientY },
      ];
      setIsDragging(false);
    },
    [containerRef, isViewportUiTarget],
  );

  const handleTouchEnd = React.useCallback((event: React.TouchEvent) => {
    if (event.touches.length === 1) {
      lastTouchRef.current = [{ x: event.touches[0].clientX, y: event.touches[0].clientY }];
      setIsDragging(true);
      return;
    }

    if (event.touches.length === 2) {
      const firstTouch = event.touches[0];
      const secondTouch = event.touches[1];
      lastTouchRef.current = [
        { x: firstTouch.clientX, y: firstTouch.clientY },
        { x: secondTouch.clientX, y: secondTouch.clientY },
      ];
      setIsDragging(false);
      return;
    }

    setIsDragging(false);
    lastTouchRef.current = null;
  }, []);

  React.useEffect(() => {
    if (!canInteractWithViewport) {
      setInspectCursor(null);
    }
  }, [canInteractWithViewport]);

  return {
    viewTransform,
    isDragging,
    inspectCursor,
    setInspectCursor,
    fitView,
    handleWheel,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    handleMouseLeave,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
  };
};
