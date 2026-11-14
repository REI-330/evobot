import {
  Route,
  Navigate,
  RouterProvider,
  createBrowserRouter,
  createHashRouter,
  createRoutesFromElements,
} from 'react-router-dom';
import { lazy, Suspense } from 'react';
import { LoginPage } from './pages/LoginPage';
import { SetupPage } from './pages/SetupPage';
import { SetupProvidersPage } from './pages/SetupProvidersPage';
import { SetupChannelsPage } from './pages/SetupChannelsPage';
import { AuthGuard } from './components/auth/AuthGuard';
import { AppLayout } from './components/layout/AppLayout';
import { APP_BASE, shouldUseHashRouter } from './utils/url';
import { BOT_FIRST_HOME_ENABLED } from './utils/bot-first';
import { shouldPreloadChatRoute } from './utils/chat-route-preload';
import { Toaster } from '@/components/ui/sonner';

let chatPagePromise:
  | Promise<{ default: typeof import('./pages/ChatPage').ChatPage }>
  | undefined;
const loadChatPage = () =>
  (chatPagePromise ??= import('./pages/ChatPage').then((m) => ({
    default: m.ChatPage,
  })));
const ChatPage = lazy(loadChatPage);

// Start the expensive chat split as soon as the entry executes, but only for
// the default/chat routes. Static HTML modulepreloads made login, setup, tasks,
// and memory download ChatPage + MarkdownRenderer even when never used.
if (
  typeof window !== 'undefined' &&
  shouldPreloadChatRoute(
    window.location.pathname,
    window.location.hash,
    APP_BASE,
  )
) {
  void loadChatPage();
}
const BotsPage = lazy(() =>
  import('./pages/BotsPage').then((m) => ({ default: m.BotsPage })),
);
const BotGroupsPage = lazy(() =>
  import('./pages/BotGroupsPage').then((m) => ({ default: m.BotGroupsPage })),
);
const TasksPage = lazy(() =>
  import('./pages/TasksPage').then((m) => ({ default: m.TasksPage })),
);
const GoalsPage = lazy(() =>
  import('./pages/GoalsPage').then((m) => ({ default: m.GoalsPage })),
);
const SettingsPage = lazy(() =>
  import('./pages/SettingsPage').then((m) => ({ default: m.SettingsPage })),
);
const AgentProfilesPage = lazy(() =>
  import('./pages/AgentProfilesPage').then((m) => ({
    default: m.AgentProfilesPage,
  })),
);
// These routes are lazy-loaded to keep the entry bundle small. CapabilitiesPage
// pulls SkillsPage → MarkdownRenderer → KaTeX + highlight.js.
const MemoryPage = lazy(() =>
  import('./pages/MemoryPage').then((m) => ({ default: m.MemoryPage })),
);
const CapabilitiesPage = lazy(() =>
  import('./pages/CapabilitiesPage').then((m) => ({
    default: m.CapabilitiesPage,
  })),
);

function AgentProfilesRouteFallback() {
  return (
    <div
      className="min-h-full px-4 py-5 sm:px-6 lg:px-8 lg:py-8"
      role="status"
      aria-live="polite"
    >
      <div className="mx-auto max-w-6xl rounded-xl border border-border bg-card/40 p-6 text-sm text-muted-foreground motion-safe:animate-pulse">
        正在加载智能体设置…
      </div>
    </div>
  );
}

const appRoutes = createRoutesFromElements(
  <>
    {/* Public Routes */}
    <Route path="/login" element={<LoginPage />} />
    <Route path="/register" element={<Navigate to="/login" replace />} />
    <Route path="/setup" element={<SetupPage />} />
    <Route
      path="/setup/providers"
      element={
        <AuthGuard>
          <SetupProvidersPage />
        </AuthGuard>
      }
    />
    <Route
      path="/setup/channels"
      element={
        <AuthGuard>
          <SetupChannelsPage />
        </AuthGuard>
      }
    />

    {/* Protected Routes with Layout */}
    <Route
      element={
        <AuthGuard>
          <AppLayout />
        </AuthGuard>
      }
    >
      <Route
        path="/chat/:groupFolder?"
        element={
          <Suspense
            fallback={
              <div
                className="flex h-full items-center justify-center text-sm text-muted-foreground motion-safe:animate-pulse"
                role="status"
                aria-live="polite"
              >
                正在加载会话…
              </div>
            }
          >
            <ChatPage />
          </Suspense>
        }
      />
      <Route path="/groups" element={<Navigate to="/chat" replace />} />
      <Route
        path="/bots"
        element={
          <Suspense fallback={null}>
            <BotsPage />
          </Suspense>
        }
      />
      <Route
        path="/bot-groups/:groupId?"
        element={
          <Suspense fallback={null}>
            <BotGroupsPage />
          </Suspense>
        }
      />
      <Route
        path="/agent-profiles"
        element={
          <Suspense fallback={<AgentProfilesRouteFallback />}>
            <AgentProfilesPage />
          </Suspense>
        }
      />
      <Route
        path="/tasks"
        element={
          <Suspense fallback={null}>
            <TasksPage />
          </Suspense>
        }
      />
      <Route
        path="/goals"
        element={
          <Suspense fallback={null}>
            <GoalsPage />
          </Suspense>
        }
      />
      <Route path="/monitor" element={<Navigate to="/settings" replace />} />
      <Route path="/usage" element={<Navigate to="/capabilities/usage" replace />} />
      <Route path="/billing" element={<Navigate to="/goals" replace />} />
      <Route
        path="/memory"
        element={
          <Suspense fallback={null}>
            <MemoryPage />
          </Suspense>
        }
      />
      <Route
        path="/capabilities/:section?"
        element={
          <Suspense fallback={null}>
            <CapabilitiesPage />
          </Suspense>
        }
      />
      <Route
        path="/skills"
        element={<Navigate to="/capabilities/skills" replace />}
      />
      <Route
        path="/mcp-servers"
        element={<Navigate to="/capabilities/mcp" replace />}
      />
      <Route
        path="/plugins"
        element={<Navigate to="/capabilities/plugins" replace />}
      />
      <Route
        path="/settings"
        element={
          <Suspense fallback={null}>
            <SettingsPage />
          </Suspense>
        }
      />
      <Route path="/users" element={<Navigate to="/settings" replace />} />
    </Route>

    {/* Default redirect — go through AuthGuard to detect setup state */}
    <Route
      path="/"
      element={
        <Navigate to={BOT_FIRST_HOME_ENABLED ? '/bots' : '/chat'} replace />
      }
    />
    <Route path="*" element={<Navigate to="/chat" replace />} />
  </>,
);

export function createAppRouter(useHashRouter = shouldUseHashRouter()) {
  const options = {
    // Router basename accepts both /mini and /mini/. Asset/API helpers keep
    // their normalized trailing slash; a bare deployment root must render.
    basename: APP_BASE === '/' ? undefined : APP_BASE.slice(0, -1),
  };
  return useHashRouter
    ? createHashRouter(appRoutes, options)
    : createBrowserRouter(appRoutes, options);
}

let appRouter: ReturnType<typeof createAppRouter> | undefined;

function getAppRouter() {
  appRouter ??= createAppRouter();
  return appRouter;
}

export function App() {
  return (
    <>
      <Toaster position="top-right" richColors />
      <RouterProvider router={getAppRouter()} />
    </>
  );
}
