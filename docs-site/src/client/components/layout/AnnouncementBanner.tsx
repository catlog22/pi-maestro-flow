import { useI18n } from '@/client/i18n/index.js';

// ---------------------------------------------------------------------------
// AnnouncementBanner — fixed release notice below the TopBar
// Dismiss state is lifted to Layout so the content padding can adapt.
// ---------------------------------------------------------------------------

interface AnnouncementBannerProps {
  onDismiss: () => void;
}

export function AnnouncementBanner({ onDismiss }: AnnouncementBannerProps) {
  const { t } = useI18n();

  return (
    <div
      role="status"
      className="fixed left-0 right-0 flex items-center justify-center gap-[var(--spacing-3)] px-[var(--spacing-4)] h-[var(--size-banner-height)] bg-tint-yellow border-b border-border-divider text-text-primary text-[12px] font-[var(--font-weight-medium)] z-[95]"
      style={{ top: 'var(--size-topbar-height)' }}
    >
      <span className="shrink-0">🎼</span>
      <span className="truncate">
        {t('announcement.title')}{' '}
        <code className="px-[var(--spacing-1)] py-[1px] rounded-[var(--radius-default)] bg-tint-blue text-accent-blue font-mono text-[11px]">
          {t('announcement.install')}
        </code>
      </span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={t('announcement.close')}
        className="shrink-0 flex items-center justify-center w-5 h-5 rounded-[var(--radius-default)] text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-all duration-[var(--duration-fast)]"
      >
        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
