import type { ReactNode } from 'react';
import { SidebarProvider } from './SidebarContext.js';
import { TopBar } from './TopBar.js';
import { Sidebar } from './Sidebar.js';
import { MainContent } from './MainContent.js';

// ---------------------------------------------------------------------------
// Layout — Gemini CLI style: TopBar + Sidebar + Content
// ---------------------------------------------------------------------------

export function Layout({ children }: { children?: ReactNode }) {
  return (
    <SidebarProvider>
      <div className="flex flex-col min-h-screen bg-bg-primary">
        <TopBar />
        <div
          className="flex h-screen"
          style={{ paddingTop: 'var(--size-topbar-height)' }}
        >
          <Sidebar />
          <MainContent>{children}</MainContent>
        </div>
      </div>
    </SidebarProvider>
  );
}
