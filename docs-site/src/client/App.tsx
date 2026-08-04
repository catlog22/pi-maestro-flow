import { Suspense, lazy } from 'react';
import { I18nProvider } from './i18n/index.js';
import { Layout } from './components/layout/Layout.js';
import { BrowserRouter, Navigate, Route, Switch, useParams } from 'react-router-dom';

const LandingPage = lazy(() => import('./pages/LandingPage.js'));
const QuickStartPage = lazy(() => import('./pages/QuickStartPage.js'));
const GuidesIndexPage = lazy(() => import('./pages/GuidesIndexPage.js'));
const GuidePage = lazy(() => import('./pages/GuidePage.js'));
const SearchPage = lazy(() => import('./pages/SearchPage.js'));

function GuideRouteWrapper() {
  const { slug } = useParams<{ slug: string }>();
  if (!slug) return <Navigate to="/guides" replace />;
  return <GuidePage slug={slug} />;
}

function Routes() {
  return (
    <Switch>
      <Route path="/"><LandingPage /></Route>
      <Route path="/quick-start"><QuickStartPage /></Route>
      <Route path="/search"><SearchPage /></Route>
      <Route path="/guides"><GuidesIndexPage /></Route>
      <Route path="/guides/:slug"><GuideRouteWrapper /></Route>
      <Route><Navigate to="/" replace /></Route>
    </Switch>
  );
}

export function App() {
  const basename = import.meta.env.BASE_URL.replace(/\/$/, '') || undefined;

  return (
    <I18nProvider>
      <BrowserRouter basename={basename}>
        <Layout>
          <Suspense
            fallback={
              <div className="flex items-center justify-center h-full">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent-blue" />
              </div>
            }
          >
            <Routes />
          </Suspense>
        </Layout>
      </BrowserRouter>
    </I18nProvider>
  );
}
