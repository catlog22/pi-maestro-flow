import { NavLink, useLocation } from 'react-router-dom';
import { useMemo } from 'react';
import { useI18n } from '@/client/i18n/index.js';
import { getAllGuideMeta } from '@/client/data/index.js';

// ---------------------------------------------------------------------------
// Breadcrumbs — warm minimal breadcrumb trail with chevron separators
// ---------------------------------------------------------------------------

interface BreadcrumbItem {
  label: string;
  href?: string;
  isCurrent: boolean;
}

export function Breadcrumbs({ className = '' }: { className?: string }) {
  const { t, locale } = useI18n();
  const location = useLocation();
  const isZh = locale === 'zh-CN';

  const items = useMemo(() => {
    const pathParts = location.pathname.split('/').filter(Boolean);
    const breadcrumbs: BreadcrumbItem[] = [];

    breadcrumbs.push({
      label: t('nav.home'),
      href: '/',
      isCurrent: pathParts.length === 0,
    });

    if (pathParts.length === 0) return breadcrumbs;

    if (pathParts[0] === 'guides') {
      breadcrumbs.push({
        label: t('nav.guides'),
        href: '/guides',
        isCurrent: pathParts.length === 1,
      });

      if (pathParts.length >= 2) {
        const slug = pathParts[1];
        const guide = getAllGuideMeta().find((g) => g.slug === slug);
        breadcrumbs.push({
          label: guide ? (isZh && guide.title_zh ? guide.title_zh : guide.title) : slug,
          isCurrent: true,
        });
      }
    } else if (pathParts[0] === 'quick-start') {
      breadcrumbs.push({
        label: t('nav.quick_start'),
        isCurrent: true,
      });
    } else if (pathParts[0] === 'search') {
      breadcrumbs.push({
        label: t('nav.search'),
        isCurrent: true,
      });
    }

    return breadcrumbs;
  }, [location.pathname, t, isZh]);

  return (
    <nav aria-label={t('breadcrumbs.aria_label')} className={className}>
      <ol className="flex items-center gap-[var(--spacing-1)] text-[length:12px] text-text-tertiary">
        {items.map((item, index) => (
          <li key={index} className="flex items-center gap-[var(--spacing-1)]">
            {index > 0 && (
              <svg className="w-3 h-3 text-text-placeholder" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 18l6-6-6-6" />
              </svg>
            )}
            {item.isCurrent || !item.href ? (
              <span className={item.isCurrent ? 'text-text-secondary font-[var(--font-weight-medium)]' : ''}>
                {item.label}
              </span>
            ) : (
              <NavLink
                to={item.href}
                className="no-underline hover:text-accent-blue transition-colors duration-[var(--duration-fast)]"
              >
                {item.label}
              </NavLink>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
