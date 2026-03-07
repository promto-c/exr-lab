import React from 'react';
import type { ExrCache } from '../../core/cache';
import type { SequenceFrame } from './sequenceUtils';
import type { PlaybackMode } from './transport';

export type UseSequenceTransportParams = {
  hasSequenceFrames: boolean;
  canPlaySequence: boolean;
  isSequencePlaying: boolean;
  setIsSequencePlaying: React.Dispatch<React.SetStateAction<boolean>>;
  playbackMode: PlaybackMode;
  sequenceFps: number;
  sequenceFrames: SequenceFrame[];
  sequenceFrameIndex: number | null;
  setSequenceFrameIndex: React.Dispatch<React.SetStateAction<number | null>>;
  isProcessing: boolean;
  exrCacheRef: React.MutableRefObject<ExrCache>;
  sequenceAutoFitRef: React.MutableRefObject<boolean>;
};

export type UseSequenceTransportResult = {
  stepSequenceFrame: (direction: 1 | -1) => void;
};

const isTextEntryTarget = (target: EventTarget | null): boolean => {
  const element = target instanceof HTMLElement ? target : null;
  if (!element) return false;
  return element.tagName === 'INPUT' || element.tagName === 'TEXTAREA';
};

export const useSequenceTransport = ({
  hasSequenceFrames,
  canPlaySequence,
  isSequencePlaying,
  setIsSequencePlaying,
  playbackMode,
  sequenceFps,
  sequenceFrames,
  sequenceFrameIndex,
  setSequenceFrameIndex,
  isProcessing,
  exrCacheRef,
  sequenceAutoFitRef,
}: UseSequenceTransportParams): UseSequenceTransportResult => {
  const stepSequenceFrame = React.useCallback(
    (direction: 1 | -1) => {
      if (sequenceFrames.length === 0) return;

      setIsSequencePlaying(false);
      sequenceAutoFitRef.current = false;
      setSequenceFrameIndex((previousIndex) => {
        const base = previousIndex ?? 0;
        const next = base + direction;
        if (next < 0) return sequenceFrames.length - 1;
        if (next >= sequenceFrames.length) return 0;
        return next;
      });
    },
    [sequenceFrames, sequenceAutoFitRef, setIsSequencePlaying, setSequenceFrameIndex],
  );

  React.useEffect(() => {
    if (!isSequencePlaying || !canPlaySequence) return;

    if (playbackMode === 'every' && isProcessing) return;

    if (playbackMode === 'cached') {
      const peekNext = (index: number): number => (index + 1) % sequenceFrames.length;
      const currentIndex = sequenceFrameIndex ?? 0;
      const nextFrame = sequenceFrames[peekNext(currentIndex)];
      if (!nextFrame || !exrCacheRef.current.hasFrame(nextFrame.id)) return;
    }

    const intervalMs = 1000 / sequenceFps;
    const timer = window.setInterval(() => {
      if (playbackMode === 'timing') {
        setSequenceFrameIndex((previousIndex) => {
          const base = previousIndex ?? 0;
          const len = sequenceFrames.length;

          for (let step = 1; step <= len; step += 1) {
            const candidate = (base + step) % len;
            const frame = sequenceFrames[candidate];
            if (frame && exrCacheRef.current.hasFrame(frame.id)) return candidate;
          }

          return (base + 1) % len;
        });
        return;
      }

      setSequenceFrameIndex((previousIndex) => {
        const base = previousIndex ?? 0;
        return (base + 1) % sequenceFrames.length;
      });
    }, intervalMs);

    return () => window.clearInterval(timer);
  }, [
    canPlaySequence,
    exrCacheRef,
    isProcessing,
    isSequencePlaying,
    playbackMode,
    sequenceFps,
    sequenceFrameIndex,
    sequenceFrames,
    setSequenceFrameIndex,
  ]);

  React.useEffect(() => {
    if (!hasSequenceFrames) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (isTextEntryTarget(event.target)) return;

      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        setIsSequencePlaying(false);
        sequenceAutoFitRef.current = false;
        setSequenceFrameIndex((previousIndex) => {
          const base = previousIndex ?? 0;
          return base === 0 ? sequenceFrames.length - 1 : base - 1;
        });
        return;
      }

      if (event.key === 'ArrowRight') {
        event.preventDefault();
        setIsSequencePlaying(false);
        sequenceAutoFitRef.current = false;
        setSequenceFrameIndex((previousIndex) => {
          const base = previousIndex ?? 0;
          return (base + 1) % sequenceFrames.length;
        });
        return;
      }

      if (event.key === ' ') {
        if (!canPlaySequence) return;
        event.preventDefault();
        setIsSequencePlaying((previous) => !previous);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    canPlaySequence,
    hasSequenceFrames,
    sequenceAutoFitRef,
    sequenceFrames.length,
    setIsSequencePlaying,
    setSequenceFrameIndex,
  ]);

  return { stepSequenceFrame };
};
