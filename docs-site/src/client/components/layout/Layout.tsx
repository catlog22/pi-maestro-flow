import { useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { SidebarProvider } from './SidebarContext.js';
import { TopBar } from './TopBar.js';
import { AnnouncementBanner } from './AnnouncementBanner.js';
import { Sidebar } from './Sidebar.js';
import { MainContent } from './MainContent.js';

// ---------------------------------------------------------------------------
// Layout — Gemini CLI style: TopBar + AnnouncementBanner + Sidebar + Content
// ---------------------------------------------------------------------------

const BANNER_DISMISSED_KEY = 'docs-site-banner-dismissed';

export function Layout({ children }: { children?: ReactNode }) {
  const [bannerVisible, setBannerVisible] = useState<boolean>(() => {
    try {
      return localStorage.getItem(BANNER_DISMISSED_KEY) !== '1';
    } catch {
      return true;
    }
  });

  const dismissBanner = () => {
    setBannerVisible(false);
    try {
      localStorage.setItem(BANNER_DISMISSED_KEY, '1');
    } catch {}
  };

  return (
    <SidebarProvider>
      <div
        className="flex flex-col min-h-screen bg-bg-primary"
        style={{ '--banner-offset': bannerVisible ? 'var(--size-banner-height)' : '0px' } as React.CSSProperties}
      >
        <TopBar />
        {bannerVisible && <AnnouncementBanner onDismiss={dismissBanner} />}
        <div
          className="flex h-screen"
          style={{ paddingTop: 'calc(var(--size-topbar-height) + var(--banner-offset))' }}
        >
          <Sidebar />
          <MainContent>{children}</MainContent>
        </div>
      </div>
    </SidebarProvider>
  );
}
