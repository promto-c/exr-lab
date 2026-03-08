import React from 'react';
import { Download } from 'lucide-react';
import type { ExrPart } from '@blackboard/exr';
import { SubPanel } from './SubPanel';
import {
  ExportCompression,
  ExportSourceMode,
  getPartLayerNames,
  getLayerChannelNames,
} from '../features/exr/exportBuilder';

export interface ExportRequest {
  scope: ExportSourceMode;
  compression: ExportCompression;
  layerPrefix?: string;
  channelName?: string;
}

interface ExportPanelProps {
  part: ExrPart | null;
  hasRawData: boolean;
  isExporting: boolean;
  defaultLayerPrefix?: string | null;
  defaultChannelName?: string | null;
  onExport: (request: ExportRequest) => void;
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  className?: string;
}

const COMPRESSION_OPTIONS: Array<{ value: ExportCompression; label: string }> = [
  { value: 0, label: 'None (0)' },
  { value: 1, label: 'RLE (1)' },
  { value: 2, label: 'ZIPS (2)' },
  { value: 3, label: 'ZIP (3)' },
  { value: 4, label: 'PIZ (4)' },
  { value: 5, label: 'PXR24 (5)' },
  { value: 6, label: 'B44 (6)' },
  { value: 7, label: 'B44A (7)' },
];

const SCOPE_OPTIONS: Array<{ value: ExportSourceMode; label: string }> = [
  { value: 'part', label: 'Whole Part' },
  { value: 'layer', label: 'Layer' },
  { value: 'channel', label: 'Single Channel' },
  { value: 'view', label: 'Current View Mapping' },
];

const inputClassName =
  'w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-xs text-neutral-100';

export const ExportPanel: React.FC<ExportPanelProps> = ({
  part,
  hasRawData,
  isExporting,
  defaultLayerPrefix,
  defaultChannelName,
  onExport,
  collapsed,
  onCollapsedChange,
  className,
}) => {
  const [scope, setScope] = React.useState<ExportSourceMode>('view');
  const [compression, setCompression] = React.useState<ExportCompression>(3);
  const [layerPrefix, setLayerPrefix] = React.useState<string>(defaultLayerPrefix ?? '(root)');
  const [channelName, setChannelName] = React.useState<string>(defaultChannelName ?? '');

  const layerNames = React.useMemo(() => (part ? getPartLayerNames(part) : []), [part]);
  const layerChannels = React.useMemo(
    () => (part ? getLayerChannelNames(part, layerPrefix) : []),
    [part, layerPrefix],
  );
  const allChannelNames = React.useMemo(
    () => (part ? part.channels.map((channel) => channel.name).sort((a, b) => a.localeCompare(b)) : []),
    [part],
  );

  React.useEffect(() => {
    if (!part) {
      setLayerPrefix('(root)');
      setChannelName('');
      return;
    }

    const nextLayer = defaultLayerPrefix && layerNames.includes(defaultLayerPrefix)
      ? defaultLayerPrefix
      : layerNames[0] ?? '(root)';
    setLayerPrefix(nextLayer);

    const nextChannel =
      defaultChannelName && allChannelNames.includes(defaultChannelName)
        ? defaultChannelName
        : allChannelNames[0] ?? '';
    setChannelName(nextChannel);
  }, [part, defaultLayerPrefix, defaultChannelName, layerNames, allChannelNames]);

  const canExport =
    Boolean(part) &&
    hasRawData &&
    !isExporting &&
    (scope !== 'layer' || layerChannels.length > 0) &&
    (scope !== 'channel' || Boolean(channelName));

  return (
    <SubPanel
      title="Export"
      icon={<Download className="w-3 h-3" />}
      className={`rounded-lg border border-neutral-800 overflow-hidden ${className ?? ''}`}
      bodyClassName="p-3 space-y-3"
      collapsed={collapsed}
      onCollapsedChange={onCollapsedChange}
    >
      {!part ? (
        <p className="text-xs text-neutral-500">Select a part before exporting.</p>
      ) : (
        <>
          <div>
            <label className="text-[11px] uppercase tracking-wide text-neutral-500">Source</label>
            <select
              value={scope}
              onChange={(event) => setScope(event.target.value as ExportSourceMode)}
              className={inputClassName}
            >
              {SCOPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          {scope === 'layer' && (
            <div>
              <label className="text-[11px] uppercase tracking-wide text-neutral-500">Layer</label>
              <select
                value={layerPrefix}
                onChange={(event) => setLayerPrefix(event.target.value)}
                className={inputClassName}
              >
                {layerNames.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {scope === 'channel' && (
            <div>
              <label className="text-[11px] uppercase tracking-wide text-neutral-500">Channel</label>
              <select
                value={channelName}
                onChange={(event) => setChannelName(event.target.value)}
                className={inputClassName}
              >
                {allChannelNames.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="text-[11px] uppercase tracking-wide text-neutral-500">Compression</label>
            <select
              value={compression}
              onChange={(event) => setCompression(Number(event.target.value) as ExportCompression)}
              className={inputClassName}
            >
              {COMPRESSION_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <button
            onClick={() => onExport({ scope, compression, layerPrefix, channelName })}
            disabled={!canExport}
            className="w-full rounded-md border border-teal-700/70 bg-teal-900/30 px-3 py-2 text-xs text-teal-200 hover:bg-teal-800/40 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {isExporting ? 'Exporting EXR...' : 'Export EXR'}
          </button>

          {!hasRawData && (
            <p className="text-[11px] text-neutral-500">
              Decode the selected part first, then export.
            </p>
          )}
        </>
      )}
    </SubPanel>
  );
};
