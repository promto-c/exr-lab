import React from 'react';
import { ChevronDown } from 'lucide-react';

interface SubPanelProps {
  title: string;
  icon?: React.ReactNode;
  headerRight?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  headerClassName?: string;
  bodyClassName?: string;
  stickyHeader?: boolean;
  collapsible?: boolean;
  defaultCollapsed?: boolean;
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
}

const cx = (...classes: Array<string | false | null | undefined>): string =>
  classes.filter(Boolean).join(' ');

export const SubPanel: React.FC<SubPanelProps> = ({
  title,
  icon,
  headerRight,
  children,
  className = '',
  headerClassName = '',
  bodyClassName = '',
  stickyHeader = false,
  collapsible = true,
  defaultCollapsed = false,
  collapsed,
  onCollapsedChange,
}) => {
  const [internalCollapsed, setInternalCollapsed] = React.useState(defaultCollapsed);
  const isControlled = collapsed !== undefined;
  const isCollapsed = isControlled ? collapsed : internalCollapsed;

  const toggleCollapsed = React.useCallback(() => {
    if (!collapsible) return;
    const nextCollapsed = !isCollapsed;
    if (!isControlled) {
      setInternalCollapsed(nextCollapsed);
    }
    onCollapsedChange?.(nextCollapsed);
  }, [collapsible, isCollapsed, isControlled, onCollapsedChange]);

  return (
    <div className={cx('flex flex-col bg-neutral-900', className)}>
      <div
        className={cx(
          'p-2 border-b border-neutral-800 bg-neutral-900',
          stickyHeader && 'sticky top-0 z-10',
          collapsible && 'cursor-pointer select-none hover:bg-neutral-800/60 transition-colors',
          headerClassName
        )}
        onClick={collapsible ? toggleCollapsed : undefined}
      >
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-xs font-bold uppercase tracking-wider text-neutral-500 flex items-center">
            {collapsible && (
              <ChevronDown
                className={cx(
                  'w-3 h-3 mr-1.5 text-neutral-600 transition-transform duration-200',
                  isCollapsed && '-rotate-90'
                )}
              />
            )}
            {icon && <span className="mr-2 inline-flex">{icon}</span>}
            {title}
          </h2>
          {headerRight}
        </div>
      </div>
      {!isCollapsed && <div className={bodyClassName}>{children}</div>}
    </div>
  );
};
