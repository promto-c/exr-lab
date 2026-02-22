import React from 'react';

type PrecisionSliderProps = {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  ariaLabel: string;
  className?: string;
  thresholdScale?: number;
  /**
   * Optional array describing which discrete positions along the slider
   * should be highlighted (e.g. frame-cache state).
   * length is treated as the number of steps; each truthy entry will be
   * painted with the accent color. The gradient is recomputed on every
   * render so callers should memoize input if expensive.
   */
  cacheMask?: boolean[];
};

type PrecisionSliderDragState = {
  pointerId: number;
  lastX: number;
  currentValue: number;
  centerY: number;
  range: number;
  trackWidth: number;
  precisionThreshold: number;
};

type PrecisionSliderStyle = React.CSSProperties & {
  '--value-pct': string;
  '--precision-scale': string;
};

// Helper functions
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

const getStepPrecision = (step: number): number => {
  const text = String(step).toLowerCase();
  if (!text.includes('e-')) {
    const dot = text.indexOf('.');
    return dot >= 0 ? text.length - dot - 1 : 0;
  }

  const [base, exponentText] = text.split('e-');
  const exponent = Number.parseInt(exponentText ?? '0', 10);
  const dot = base.indexOf('.');
  const basePrecision = dot >= 0 ? base.length - dot - 1 : 0;
  return basePrecision + exponent;
};

const snapToStep = (value: number, min: number, step: number): number => {
  if (!Number.isFinite(step) || step <= 0) return value;
  const precision = getStepPrecision(step);
  const snapped = min + Math.round((value - min) / step) * step;
  return Number(snapped.toFixed(precision));
};

const valueToPercent = (value: number, min: number, max: number): number => {
  if (max <= min) return 0;
  return ((clamp(value, min, max) - min) / (max - min)) * 100;
};

const pointerToValue = (
  clientX: number,
  rect: DOMRect,
  min: number,
  max: number,
  step: number
): number => {
  if (max <= min) return min;
  const ratio = clamp((clientX - rect.left) / Math.max(rect.width, 1), 0, 1);
  const raw = min + ratio * (max - min);
  return snapToStep(raw, min, step);
};

export const PrecisionSlider = ({
  value,
  min,
  max,
  step,
  onChange,
  ariaLabel,
  className = '',
  thresholdScale = 1,
  cacheMask,
}: PrecisionSliderProps) => {
  const sliderRef = React.useRef<HTMLDivElement>(null);
  const dragRef = React.useRef<PrecisionSliderDragState | null>(null);
  const [precisionScale, setPrecisionScale] = React.useState(1);

  const valuePct = React.useMemo(() => valueToPercent(value, min, max), [value, min, max]);

  const commitValue = React.useCallback((next: number): number => {
    const snapped = snapToStep(next, min, step);
    const clamped = clamp(snapped, min, max);
    onChange(clamped);
    return clamped;
  }, [max, min, onChange, step]);

  const releaseDrag = React.useCallback(() => {
    dragRef.current = null;
    setPrecisionScale(1);
  }, []);

  const handlePointerDown = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'touch' && event.button !== 0) return;

    const slider = sliderRef.current;
    if (!slider) return;

    const rect = slider.getBoundingClientRect();
    const initialValue = pointerToValue(event.clientX, rect, min, max, step);
    const committedValue = commitValue(initialValue);

    dragRef.current = {
      pointerId: event.pointerId,
      lastX: event.clientX,
      currentValue: committedValue,
      centerY: rect.top + rect.height / 2,
      range: max - min,
      trackWidth: Math.max(rect.width, 1),
      precisionThreshold: Math.max(rect.height * thresholdScale, 1),
    };

    setPrecisionScale(1);
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }, [commitValue, max, min, step, thresholdScale]);

  const handlePointerMove = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    const perpendicularDistance = Math.abs(event.clientY - drag.centerY);
    const distanceScale =
      perpendicularDistance <= drag.precisionThreshold
        ? 1
        : drag.precisionThreshold / perpendicularDistance;

    setPrecisionScale(distanceScale);

    const horizontalDelta = event.clientX - drag.lastX;
    if (horizontalDelta === 0) return;

    const scaledDelta = (horizontalDelta / drag.trackWidth) * drag.range * distanceScale;
    const committedValue = commitValue(drag.currentValue + scaledDelta);

    drag.currentValue = committedValue;
    drag.lastX = event.clientX;
  }, [commitValue]);

  const handlePointerUp = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    releaseDrag();
  }, [releaseDrag]);

  const handleKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    let nextValue: number | null = null;

    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') nextValue = value - step;
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') nextValue = value + step;
    if (event.key === 'PageDown') nextValue = value - step * 10;
    if (event.key === 'PageUp') nextValue = value + step * 10;
    if (event.key === 'Home') nextValue = min;
    if (event.key === 'End') nextValue = max;

    if (nextValue === null) return;

    event.preventDefault();
    commitValue(nextValue);
  }, [commitValue, max, min, step, value]);

  // build a gradient that colors cached segments using the accent color;
  // un-cached pieces remain the default track color.  We only bother when
  // a mask is provided and has the same length as the number of steps.
  const trackBackground = React.useMemo((): string | undefined => {
    if (!cacheMask || cacheMask.length === 0) return undefined;
    const len = cacheMask.length;
    if (len === 0) return undefined;
    const segs: string[] = [];
    const trackColor = 'var(--tone-slider-track)';
    const cacheColor = 'var(--theme-accent)';
    for (let i = 0; i < len; i++) {
      const start = (i / len) * 100;
      const end = ((i + 1) / len) * 100;
      const color = cacheMask[i] ? cacheColor : trackColor;
      segs.push(`${color} ${start}% ${end}%`);
    }
    return `linear-gradient(to right, ${segs.join(', ')})`;
  }, [cacheMask]);

  const style: PrecisionSliderStyle = {
    '--value-pct': `${valuePct}%`,
    '--precision-scale': `${precisionScale}`,
  };

  return (
    <div
      ref={sliderRef}
      className={`tone-slider ${className}`.trim()}
      style={style}
      role="slider"
      tabIndex={0}
      aria-label={ariaLabel}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onLostPointerCapture={releaseDrag}
      onKeyDown={handleKeyDown}
    >
      <div
        className="tone-slider__track"
        aria-hidden="true"
        style={trackBackground ? { background: trackBackground } : undefined}
      />
      <div className="tone-slider__fill" aria-hidden="true" />
      <div className="tone-slider__handle" aria-hidden="true" />
    </div>
  );
};
