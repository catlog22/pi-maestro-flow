import { useState, useMemo, useEffect } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useI18n } from '@/client/i18n/index.js';
import { useSidebar } from './SidebarContext.js';
import { guideCategories } from '@/client/routes/route-config.js';
import { getAllGuideMeta } from '@/client/data/index.js';
import { getGuideIcon } from '@/client/utils/guideIcons.js';

// ---------------------------------------------------------------------------
// Sidebar — Gemini CLI style: clean grouped navigation, blue active pills
// ---------------------------------------------------------------------------

interface CategorySection {
  id: string;
  titleKey: string;
  guides: Array<{ slug: string; title_zh: string; title: string; icon: string }>;
  isOpen: boolean;
}

export function Sidebar() {
  const { t } = useI18n();
  const location = useLocation();
  const { isOpen: isMobileOpen, close: closeSidebar } = useSidebar();

  useEffect(() => {
    closeSidebar();
  }, [location.pathname, closeSidebar]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isMobileOpen) {
        closeSidebar();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isMobileOpen, closeSidebar]);

  const defaultSections: CategorySection[] = useMemo(() => {
    return guideCategories.map((cat) => ({
      id: cat.id,
      titleKey: `categories.${cat.id.replace('-', '_')}`,
      guides: getAllGuideMeta().filter((g) => g.category === cat.id),
      isOpen: cat.id === 'getting-started' || cat.id === 'configuration',
    }));
  }, []);

  const [sections, setSections] = useState<CategorySection[]>(defaultSections);

  useEffect(() => {
    setSections(defaultSections);
  }, [defaultSections]);

  const toggleSection = (id: string) => {
    setSections((prev) =>
      prev.map((section) =>
        section.id === id ? { ...section, isOpen: !section.isOpen } : section
      )
    );
  };

  return (
    <>
      {/* Mobile backdrop overlay */}
      {isMobileOpen && (
        <div
          className="fixed inset-0 bg-black/30 z-40 lg:hidden"
          onClick={closeSidebar}
          aria-hidden="true"
        />
      )}

      <aside
        role="navigation"
        aria-label={t('sidebar.categories')}
        className={[
          'fixed left-0 w-[var(--size-sidebar-width)] overflow-y-auto',
          'bg-bg-primary border-r border-border-divider z-50',
          'transition-transform duration-[var(--duration-smooth)] ease-[var(--ease-notion)]',
          'max-lg:-translate-x-full',
          isMobileOpen ? 'max-lg:translate-x-0' : '',
        ].join(' ')}
        style={{ top: 'var(--size-topbar-height)', bottom: 0 }}
      >
        <nav className="py-[var(--spacing-4)]" aria-label={t('sidebar.aria_nav')}>
          {/* Quick Start — top level */}
          <SidebarQuickStartLink />

          {/* Divider */}
          <div className="mx-[var(--spacing-4)] my-[var(--spacing-2)] border-t border-border-divider" />

          {/* Category sections */}
          {sections.map((section) => (
            <SidebarSection
              key={section.id}
              section={section}
              onToggle={() => toggleSection(section.id)}
            />
          ))}
        </nav>
      </aside>
    </>
  );
}

// ---------------------------------------------------------------------------
// SidebarSection — collapsible category section listing its guides
// ---------------------------------------------------------------------------

interface SidebarSectionProps {
  section: CategorySection;
  onToggle: () => void;
}

function SidebarSection({ section, onToggle }: SidebarSectionProps) {
  const { t, locale } = useI18n();
  const location = useLocation();
  const isZh = locale === 'zh-CN';
  const sectionActive = location.pathname.startsWith(`/guides/`) &&
    getAllGuideMeta().some(
      (g) => g.category === section.id && location.pathname === `/guides/${g.slug}`
    );

  return (
    <div className="px-[var(--spacing-3)] mb-[var(--spacing-1)]">
      {/* Section header */}
      <div className="flex items-center justify-between">
        <span
          className={[
            'flex items-center gap-[var(--spacing-2)] px-[8px] py-[4.8px]',
            'text-[length:14px] font-[var(--font-weight-semibold)]',
            'transition-colors duration-[var(--duration-fast)]',
            'rounded-[var(--radius-sm)] flex-1',
            sectionActive ? 'text-accent-blue' : 'text-text-tertiary hover:text-text-secondary',
          ].join(' ')}
        >
          {t(section.titleKey)}
        </span>

        <button
          type="button"
          onClick={onToggle}
          aria-expanded={section.isOpen}
          aria-label={`Toggle ${t(section.titleKey)} section`}
          className="p-1.5 min-w-7 min-h-7 flex items-center justify-center rounded-[var(--radius-sm)] hover:bg-bg-hover text-text-tertiary transition-colors duration-[var(--duration-fast)]"
        >
          <svg
            className={[
              'w-3 h-3 transition-transform duration-[var(--duration-fast)]',
              section.isOpen ? 'rotate-90' : '',
            ].join(' ')}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>

      {/* Section guides */}
      {section.isOpen && section.guides.length > 0 && (
        <div className="mt-[var(--spacing-0-5)] flex flex-col gap-px">
          {section.guides.map((guide) => {
            const href = `/guides/${guide.slug}`;
            const isActive = location.pathname === href;
            return (
              <NavLink
                key={guide.slug}
                to={href}
                className={[
                  'flex items-center gap-[var(--spacing-2)] px-[8px] py-[4.2px]',
                  'text-[length:14px]',
                  'transition-all duration-[var(--duration-fast)]',
                  'rounded-[var(--radius-sm)]',
                  isActive
                    ? 'bg-accent-blue text-text-inverse font-[var(--font-weight-semibold)]'
                    : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover',
                ].join(' ')}
              >
                <span className={`shrink-0 ${isActive ? 'text-white' : 'text-text-tertiary'}`}>
                  {getGuideIcon(guide.icon, 'w-3.5 h-3.5')}
                </span>
                <span className="truncate">
                  {isZh && guide.title_zh ? guide.title_zh : guide.title}
                </span>
              </NavLink>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SidebarQuickStartLink — top-level entry, same hierarchy as Guides
// ---------------------------------------------------------------------------

function SidebarQuickStartLink() {
  const { t } = useI18n();
  const location = useLocation();
  const isActive = location.pathname === '/quick-start';

  return (
    <div className="px-[var(--spacing-3)]">
      <NavLink
        to="/quick-start"
        className={[
          'flex items-center gap-[var(--spacing-2)] px-[var(--spacing-3)] py-[var(--spacing-1-5)]',
          'text-[length:var(--font-size-sm)] font-[var(--font-weight-medium)]',
          'transition-all duration-[var(--duration-fast)]',
          'rounded-[var(--radius-sm)]',
          isActive
            ? 'bg-accent-blue text-text-inverse'
            : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover',
        ].join(' ')}
      >
        {getGuideIcon('rocket', 'w-4 h-4')}
        {t('sidebar.quick_start')}
      </NavLink>
    </div>
  );
}
