import {
  type AnchorHTMLAttributes,
  type ReactNode,
  useEffect,
} from 'react';
import {
  Link as WouterLink,
  Route,
  Router,
  Switch,
  useLocation as useWouterLocation,
  useParams as useWouterParams,
} from 'wouter';

interface BrowserRouterProps {
  basename?: string;
  children: ReactNode;
}

export function BrowserRouter({ basename, children }: BrowserRouterProps) {
  return <Router base={basename}>{children}</Router>;
}

interface NavigateOptions {
  replace?: boolean;
  state?: unknown;
}

export function useNavigate() {
  const [, navigate] = useWouterLocation();
  return (to: string, options: NavigateOptions = {}) => {
    navigate(to, { replace: options.replace, state: options.state });
  };
}

export function useLocation() {
  const [pathname] = useWouterLocation();
  return {
    pathname,
    search: window.location.search,
    hash: window.location.hash,
    state: window.history.state,
  };
}

export function useParams<T extends Record<string, string | undefined>>() {
  return useWouterParams() as T;
}

interface NavigateProps extends NavigateOptions {
  to: string;
}

export function Navigate({ to, replace, state }: NavigateProps) {
  const navigate = useNavigate();
  useEffect(() => {
    navigate(to, { replace, state });
  }, [navigate, replace, state, to]);
  return null;
}

interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  to: string;
  replace?: boolean;
  state?: unknown;
}

export function Link({ to, replace, state, ...props }: LinkProps) {
  return <WouterLink href={to} replace={replace} state={state} {...props} />;
}

interface NavLinkState {
  isActive: boolean;
  isPending: false;
}

interface NavLinkProps extends Omit<LinkProps, 'children' | 'className'> {
  children?: ReactNode | ((state: NavLinkState) => ReactNode);
  className?: string | ((state: NavLinkState) => string);
  end?: boolean;
}

export function NavLink({ children, className, end = false, to, ...props }: NavLinkProps) {
  const { pathname } = useLocation();
  const isActive = end
    ? pathname === to
    : pathname === to || pathname.startsWith(`${to.replace(/\/$/, '')}/`);
  const state: NavLinkState = { isActive, isPending: false };

  return (
    <Link
      to={to}
      className={typeof className === 'function' ? className(state) : className}
      {...props}
    >
      {typeof children === 'function' ? children(state) : children}
    </Link>
  );
}

export { Route, Switch };
