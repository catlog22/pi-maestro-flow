import { useEffect, useRef, useState } from 'react';
import { extractToc } from './MarkdownRenderer.js';
import { useI18n } from '@/client/i18n/index.js';

// ---------------------------------------------------------------------------
// FloatingToc — Gemini CLI style: "On this page" right-side TOC
// ---------------------------------------------------------------------------

interface FloatingTocProps {
  content: string;
}

export function FloatingToc({ content }: FloatingTocProps) {
  const { t } = useI18n();
  const headings = extractToc(content);
  const [activeId, setActiveId] = useState<string>('');
  const rafRef = useRef(0);

  useEffect(() => {
    if (headings.length === 0) return;

    const scrollContainer = document.querySelector('main');
    if (!scrollContainer) return;

    const handleScroll = () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        const containerTop = scrollContainer.getBoundingClientRect().top;
        let current = headings[0]?.id || '';
        for (const { id } of headings) {
          const el = document.getElementById(id);
          if (!el) continue;
          if (el.getBoundingClientRect().top <= containerTop + 80) {
            current = id;
          }
        }
        setActiveId(current);
      });
    };

    handleScroll();
    scrollContainer.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      scrollContainer.removeEventListener('scroll', handleScroll);
      cancelAnimationFrame(rafRef.current);
    };
  }, [headings]);

  if (headings.length === 0) return null;

  return (
    <aside className="hidden xl:block shrink-0 w-[var(--size-toc-width)]">
      <nav
        className="sticky top-[var(--spacing-8)] max-h-[calc(100vh-var(--size-topbar-height)-var(--spacing-16))] overflow-y-auto"
        aria-label={t('toc.aria_label')}
      >
        <div className="text-[length:12px] font-[var(--font-weight-semibold)] uppercase tracking-[var(--letter-spacing-wide)] text-text-tertiary mb-[var(--spacing-3)] px-[var(--spacing-1)]">
          {t('toc.on_this_page')}
        </div>
        <ul className="flex flex-col gap-px border-l border-border-divider">
          {headings.map(({ id, level, text }) => {
            const isActive = activeId === id;
            const indent = level > 2 ? (level - 2) * 12 : 0;
            return (
              <li key={id}>
                <a
                  href={`#${id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }}
                  className={[
                    'block text-[length:13px] leading-[1.5] py-[3px] px-[var(--spacing-2)] transition-all duration-150 no-underline truncate',
                    isActive
                      ? 'text-accent-blue font-[var(--font-weight-medium)] border-l-2 -ml-px border-accent-blue'
                      : 'text-text-tertiary hover:text-text-secondary',
                  ].join(' ')}
                  style={{ paddingLeft: `calc(var(--spacing-2) + ${indent}px)` }}
                >
                  {text}
                </a>
              </li>
            );
          })}
        </ul>
      </nav>
    </aside>
  );
}
