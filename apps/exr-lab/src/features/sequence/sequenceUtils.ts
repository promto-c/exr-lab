export type SequenceFrame = {
  id: string;
  file: File;
  name: string;
  relativePath: string;
  sequenceKey: string;
  frameNumber: number | null;
};

export type SequenceSource = {
  id: string;
  label: string;
  frames: SequenceFrame[];
};

type SequenceDescriptor = {
  sequenceKey: string;
  frameNumber: number | null;
  frameDigits: string;
  sequencePath: string;
  extension: string;
};

const EXR_FILE_PATTERN = /\.exr$/i;

export const isExrPath = (path: string): boolean => EXR_FILE_PATTERN.test(path);

const getRelativePath = (file: File): string => {
  const relative =
    typeof file.webkitRelativePath === 'string' && file.webkitRelativePath.length > 0
      ? file.webkitRelativePath
      : file.name;

  return relative.replace(/\\/g, '/');
};

const getSequenceDescriptor = (relativePath: string): SequenceDescriptor => {
  const normalizedPath = relativePath.replace(/\\/g, '/');
  const slashIndex = normalizedPath.lastIndexOf('/');
  const directory = slashIndex >= 0 ? normalizedPath.slice(0, slashIndex) : '';
  const fileName = slashIndex >= 0 ? normalizedPath.slice(slashIndex + 1) : normalizedPath;
  const dotIndex = fileName.lastIndexOf('.');
  const extension = dotIndex >= 0 ? fileName.slice(dotIndex) : '';
  const stem = dotIndex >= 0 ? fileName.slice(0, dotIndex) : fileName;
  const match = stem.match(/^(.*?)(\d+)$/);

  if (!match) {
    const sequencePath = directory ? `${directory}/${stem}` : stem;
    return {
      sequenceKey: `${sequencePath.toLowerCase()}${extension.toLowerCase()}`,
      frameNumber: null,
      frameDigits: '',
      sequencePath,
      extension,
    };
  }

  const prefix = match[1];
  const frameDigits = match[2];
  const frameNumber = Number.parseInt(frameDigits, 10);
  const sequencePath = directory ? `${directory}/${prefix}` : prefix;
  return {
    sequenceKey: `${sequencePath.toLowerCase()}#${extension.toLowerCase()}`,
    frameNumber: Number.isFinite(frameNumber) ? frameNumber : null,
    frameDigits,
    sequencePath,
    extension,
  };
};

const sortSequenceEntries = (a: SequenceFrame, b: SequenceFrame): number => {
  if (
    a.sequenceKey === b.sequenceKey &&
    a.frameNumber !== null &&
    b.frameNumber !== null &&
    a.frameNumber !== b.frameNumber
  ) {
    return a.frameNumber - b.frameNumber;
  }

  return a.relativePath.localeCompare(b.relativePath, undefined, {
    numeric: true,
    sensitivity: 'base',
  });
};

const formatFrame = (frame: number, padding: number): string =>
  String(frame).padStart(Math.max(padding, 1), '0');

export const buildSequenceSourcesFromFiles = (files: File[]): SequenceSource[] => {
  const exrEntries = files
    .map((file) => {
      const relativePath = getRelativePath(file);
      if (!isExrPath(relativePath)) return null;
      const sequence = getSequenceDescriptor(relativePath);

      return {
        file,
        relativePath,
        name: relativePath.split('/').pop() || file.name,
        sequenceKey: sequence.sequenceKey,
        frameNumber: sequence.frameNumber,
        frameDigits: sequence.frameDigits,
        sequencePath: sequence.sequencePath,
        extension: sequence.extension,
      };
    })
    .filter(
      (
        entry,
      ): entry is {
        file: File;
        relativePath: string;
        name: string;
        sequenceKey: string;
        frameNumber: number | null;
        frameDigits: string;
        sequencePath: string;
        extension: string;
      } => entry !== null,
    );

  if (exrEntries.length === 0) return [];

  const groups = new Map<
    string,
    {
      sequenceKey: string;
      sequencePath: string;
      extension: string;
      maxFrameDigits: number;
      frames: SequenceFrame[];
    }
  >();

  for (const entry of exrEntries) {
    const existing = groups.get(entry.sequenceKey);
    const frame: SequenceFrame = {
      id: `${entry.relativePath}-${entry.sequenceKey}`,
      file: entry.file,
      name: entry.name,
      relativePath: entry.relativePath,
      sequenceKey: entry.sequenceKey,
      frameNumber: entry.frameNumber,
    };

    if (existing) {
      existing.frames.push(frame);
      existing.maxFrameDigits = Math.max(existing.maxFrameDigits, entry.frameDigits.length);
      continue;
    }

    groups.set(entry.sequenceKey, {
      sequenceKey: entry.sequenceKey,
      sequencePath: entry.sequencePath,
      extension: entry.extension,
      maxFrameDigits: entry.frameDigits.length,
      frames: [frame],
    });
  }

  const sources: SequenceSource[] = Array.from(groups.values())
    .map((group) => {
      const frames = [...group.frames].sort(sortSequenceEntries);
      const numberedFrames = frames.filter(
        (frame): frame is SequenceFrame & { frameNumber: number } => frame.frameNumber !== null,
      );

      let label: string;
      if (numberedFrames.length > 0) {
        const minFrame = numberedFrames[0].frameNumber;
        const maxFrame = numberedFrames[numberedFrames.length - 1].frameNumber;
        const padding = Math.max(
          group.maxFrameDigits,
          String(minFrame).length,
          String(maxFrame).length,
        );
        label = `${group.sequencePath}.[${formatFrame(minFrame, padding)}-${formatFrame(maxFrame, padding)}]${group.extension}`;
      } else if (frames.length === 1) {
        label = frames[0].relativePath;
      } else {
        label = `${group.sequencePath}${group.extension}`;
      }

      return {
        id: group.sequenceKey,
        label,
        frames,
      };
    })
    .sort((a, b) => {
      if (b.frames.length !== a.frames.length) {
        return b.frames.length - a.frames.length;
      }
      return a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' });
    });

  return sources;
};
