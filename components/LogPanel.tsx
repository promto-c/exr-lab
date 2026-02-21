import React from 'react';
import { LogEntry, LogStatus } from '../types';
import { CheckCircle2, AlertTriangle, XCircle, Clock, ChevronDown, ChevronRight, Activity } from 'lucide-react';
import { SubPanel } from './SubPanel';

interface LogPanelProps {
  logs: LogEntry[];
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
}

const StatusIcon = ({ status }: { status: LogStatus }) => {
  switch (status) {
    case LogStatus.Ok: return <CheckCircle2 className="w-4 h-4 text-emerald-400" />;
    case LogStatus.Warn: return <AlertTriangle className="w-4 h-4 text-amber-400" />;
    case LogStatus.Error: return <XCircle className="w-4 h-4 text-red-400" />;
    default: return <Activity className="w-4 h-4 text-teal-400 animate-pulse" />;
  }
};

const MetricBadge: React.FC<{ label: string; value: string | number }> = ({ label, value }) => (
  <div className="flex items-center space-x-2 text-xs bg-neutral-800/50 px-2 py-1 rounded border border-neutral-700">
    <span className="text-neutral-400 font-medium">{label}:</span>
    <span className="text-neutral-200 font-mono">{value}</span>
  </div>
);

const DetailView = ({ details }: { details: LogEntry['details'] }) => {
  if (!details) return null;

  if (details.type === 'table') {
    const data = details.data as any;
    return (
      <div className="mt-3 overflow-x-auto">
        {data.channels && data.channels.length > 0 && (
          <div className="mb-2">
            <h4 className="text-xs font-semibold text-neutral-400 mb-1">Channels</h4>
            <div className="flex flex-wrap gap-1">
              {data.channels.map((ch: any, i: number) => (
                <span key={i} className="px-1.5 py-0.5 bg-teal-900/30 text-teal-300 text-[10px] rounded border border-teal-800/50">
                  {ch.name}
                </span>
              ))}
            </div>
          </div>
        )}
        <h4 className="text-xs font-semibold text-neutral-400 mb-1">Attributes</h4>
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="text-[10px] text-neutral-500 border-b border-neutral-700">
              <th className="pb-1 font-normal">Name</th>
              <th className="pb-1 font-normal">Value</th>
            </tr>
          </thead>
          <tbody className="text-[11px] font-mono text-neutral-300">
            {data.attributes.map((row: any, i: number) => (
              <tr key={i} className="border-b border-neutral-800/50">
                <td className="py-1 pr-2 text-neutral-400">{row.key}</td>
                <td className="py-1 truncate max-w-[140px]" title={row.val}>{row.val}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (details.type === 'chunk-map') {
      // Simulate a chunk map visualization
      const { total } = details.data as any;
      return (
          <div className="mt-2">
              <h4 className="text-[10px] text-neutral-500 uppercase font-bold mb-1">Chunk Map</h4>
              <div className="flex h-2 w-full bg-neutral-800 rounded overflow-hidden">
                  {/* For large counts, we just show a solid bar for now, or segments */}
                  <div className="h-full bg-teal-500/80 w-full" title={`Read ${total} chunks successfully`}></div>
              </div>
              <div className="flex justify-between text-[9px] text-neutral-600 mt-1 font-mono">
                  <span>0</span>
                  <span>{total}</span>
              </div>
          </div>
      )
  }
  
  return null;
};

const LogItem: React.FC<{ log: LogEntry }> = ({ log }) => {
  const [expanded, setExpanded] = React.useState(true);

  return (
    <div className="border-l-2 border-neutral-700 ml-2 pl-4 pb-6 relative group">
      <div className={`absolute -left-[9px] top-0 w-4 h-4 rounded-full border-2 border-neutral-900 bg-neutral-800 flex items-center justify-center ${
        log.status === LogStatus.Ok ? 'border-emerald-900/50' : ''
      }`}>
        <div className={`w-1.5 h-1.5 rounded-full ${
            log.status === LogStatus.Ok ? 'bg-emerald-500' : 
            log.status === LogStatus.Error ? 'bg-red-500' : 'bg-teal-500'
        }`} />
      </div>

      <div className="flex items-start justify-between cursor-pointer" onClick={() => setExpanded(!expanded)}>
        <div className="flex items-center space-x-2">
          <StatusIcon status={log.status} />
          <h3 className="text-sm font-semibold text-neutral-200">{log.title}</h3>
        </div>
        <div className="flex items-center space-x-2 text-neutral-500">
          <span className="text-[10px] font-mono flex items-center">
            <Clock className="w-3 h-3 mr-1" />
            {log.ms.toFixed(1)}ms
          </span>
          {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </div>
      </div>
      
      {log.description && expanded && (
          <p className="text-xs text-neutral-400 mt-1 mb-2 italic">{log.description}</p>
      )}

      {expanded && (
        <div className="mt-2 animate-in fade-in slide-in-from-top-1 duration-200">
          <div className="flex flex-wrap gap-2 mb-2">
            {log.metrics.map((m, i) => (
              <MetricBadge key={i} label={m.label} value={m.value} />
            ))}
          </div>
          {log.details && <DetailView details={log.details} />}
        </div>
      )}
    </div>
  );
};

export const LogPanel: React.FC<LogPanelProps> = ({ logs, collapsed, onCollapsedChange }) => {
  const bottomRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (bottomRef.current) {
        bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs.length]);

  return (
    <SubPanel
      title="Pipeline Log"
      icon={<Activity className="w-3 h-3" />}
      className="h-full"
      bodyClassName="flex-1 overflow-y-auto p-4"
      stickyHeader
      collapsed={collapsed}
      onCollapsedChange={onCollapsedChange}
    >
      <>
        {logs.length === 0 ? (
          <div className="text-center mt-10 text-neutral-600 text-sm">
            <p>No operations yet.</p>
            <p className="text-xs mt-1">Load an EXR file to begin.</p>
          </div>
        ) : (
          <div className="pt-2">
            {logs.map((log) => (
              <LogItem key={log.id} log={log} />
            ))}
          </div>
        )}
        <div ref={bottomRef} />
      </>
    </SubPanel>
  );
};
