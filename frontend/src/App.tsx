import {
  BookOpen,
  Clock,
  Database,
  FileText,
  FlaskConical,
  Home,
  Menu,
  Settings,
  Workflow,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  Link,
  NavLink,
  Outlet,
  type RouteObject,
  useLocation,
  useMatches,
} from 'react-router';
import { HistoryPage } from './components/HistoryPage';
import { HomePage } from './components/HomePage';
import { SettingsPage } from './components/SettingsPage';
import { useTheme } from './lib/theme';

const pages = [
  { path: '/', label: 'Home', icon: Home, Component: HomePage },
  {
    path: '/datasets',
    label: 'Datasets & Tasks',
    icon: Database,
    load: async () => (await import('./components/DatasetsPage')).DatasetsPage,
  },
  {
    path: '/pipelines',
    label: 'Pipelines',
    icon: Workflow,
    load: async () =>
      (await import('./components/PipelinesPage')).PipelinesPage,
  },
  {
    path: '/experiments',
    label: 'Experiments',
    icon: FlaskConical,
    load: async () =>
      (await import('./components/ExperimentsPage')).ExperimentsPage,
  },
  {
    path: '/reports/:runId?',
    to: '/reports',
    label: 'Reports',
    icon: FileText,
    load: async () => (await import('./components/ReportsPage')).ReportsPage,
  },
  { path: '/history', label: 'History', icon: Clock, Component: HistoryPage },
  {
    path: '/docs',
    label: 'Documentation',
    icon: BookOpen,
    load: async () =>
      (await import('./components/DocumentationPage')).DocumentationPage,
  },
  {
    path: '/settings',
    label: 'Settings',
    icon: Settings,
    Component: SettingsPage,
  },
];

function Navigation() {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [open]);
  return (
    <header className="border-b bg-card">
      <div className="mx-auto flex max-w-screen-2xl flex-wrap items-center justify-between gap-3 px-4 py-3 lg:px-8">
        <Link
          to="/"
          className="flex items-center gap-2 font-semibold tracking-tight"
        >
          <FlaskConical aria-hidden="true" className="text-primary" /> RAG
          Evaluation Lab
        </Link>
        <button
          type="button"
          ref={button}
          aria-expanded={open}
          aria-controls="navigation"
          onClick={() => setOpen(!open)}
          className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm lg:hidden"
        >
          {open ? (
            <X size={16} aria-hidden="true" />
          ) : (
            <Menu size={16} aria-hidden="true" />
          )}{' '}
          Menu
        </button>
        <nav
          id="navigation"
          aria-label="Main navigation"
          className={`${open ? 'grid' : 'hidden'} w-full grid-cols-2 gap-1 lg:flex lg:w-auto lg:flex-wrap`}
        >
          {pages.map(({ path, to = path, label, icon: Icon }) => (
            <NavLink
              key={path}
              to={to}
              end={path === '/'}
              onClick={() => setOpen(false)}
              className="flex items-center gap-2 rounded-md px-2.5 py-2 text-sm text-muted-foreground hover:bg-muted aria-[current=page]:bg-accent aria-[current=page]:text-primary"
            >
              <Icon size={16} aria-hidden="true" />
              {label}
            </NavLink>
          ))}
        </nav>
      </div>
    </header>
  );
}

function Shell() {
  const { pathname } = useLocation();
  const matches = useMatches();
  const title = String(matches.at(-1)?.handle);
  const main = useRef<HTMLElement>(null);
  const previousPath = useRef(pathname);
  const theme = useTheme();
  useEffect(() => {
    document.title = `${title} · RAG Evaluation Lab`;
    if (pathname !== previousPath.current) {
      main.current?.focus();
      previousPath.current = pathname;
      window.scrollTo(0, 0);
    }
  }, [pathname, title]);
  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-card focus:p-3"
      >
        Skip to content
      </a>
      <Navigation key={pathname} />
      <main id="main" aria-label={title} ref={main} tabIndex={-1}>
        <Outlet context={theme} />
      </main>
    </>
  );
}

function NotFound() {
  return (
    <section className="page">
      <h1>Page not found</h1>
      <Link className="text-primary underline" to="/">
        Return home
      </Link>
    </section>
  );
}

function LoadingPage() {
  return <p role="status" className="page">Loading page…</p>;
}

export function createRoutes(): RouteObject[] {
  return [
    {
      Component: Shell,
      HydrateFallback: LoadingPage,
      children: [
        ...pages.map(({ label, icon: _icon, to: _to, load, ...route }) => ({
          ...route,
          lazy: load ? { Component: load } : undefined,
          handle: label,
        })),
        { path: '*', handle: 'Page not found', Component: NotFound },
      ],
    },
  ];
}
