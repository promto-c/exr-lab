import React from 'react';

interface SubPanelProps {
  title: string;
  icon?: React.ReactNode;
  headerRight?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  headerClassName?: string;
  bodyClassName?: string;
  stickyHeader?: boolean;
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
}) => {
  return (
    <div className={cx('flex flex-col bg-neutral-900', className)}>
      <div
        className={cx(
          'p-3 border-b border-neutral-800 bg-neutral-900',
          stickyHeader && 'sticky top-0 z-10',
          headerClassName
        )}
      >
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-xs font-bold uppercase tracking-wider text-neutral-500 flex items-center">
            {icon && <span className="mr-2 inline-flex">{icon}</span>}
            {title}
          </h2>
          {headerRight}
        </div>
      </div>
      <div className={bodyClassName}>{children}</div>
    </div>
  );
};
