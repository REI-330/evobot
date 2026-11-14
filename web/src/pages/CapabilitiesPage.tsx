import { lazy, Suspense } from 'react';
import { Link, NavLink, Navigate, useParams } from 'react-router-dom';
import { BarChart3, Bot, Plug, Puzzle, Server } from 'lucide-react';

import { McpServersPage } from './McpServersPage';
import { PluginsPage } from './PluginsPage';
import { SkillsPage } from './SkillsPage';

const UsagePage = lazy(() =>
  import('./UsagePage').then((m) => ({ default: m.UsagePage })),
);

const sections = [
  { key: 'skills', label: 'Skills', icon: Puzzle },
  { key: 'mcp', label: 'MCP', icon: Server },
  { key: 'plugins', label: 'Plugins', icon: Plug },
  { key: 'usage', label: '用量', icon: BarChart3 },
] as const;

export function CapabilitiesPage() {
  const { section } = useParams<{ section?: string }>();
  if (!section) return <Navigate to="/capabilities/skills" replace />;
  if (!sections.some((item) => item.key === section)) {
    return <Navigate to="/capabilities/skills" replace />;
  }

  return (
    <div className="product-advanced-page min-h-full bg-background">
      <div className="sticky top-0 z-20 border-b border-border bg-background px-4 py-3 lg:px-6">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-2">
          <span className="mr-2 text-sm font-medium text-foreground">
            能力与用量
          </span>
          {sections.map(({ key, label, icon: Icon }) => (
            <NavLink
              key={key}
              to={`/capabilities/${key}`}
              className={({ isActive }) =>
                `inline-flex min-h-11 items-center gap-1.5 rounded-lg px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                  isActive
                    ? 'bg-brand-50 font-medium text-primary'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                }`
              }
            >
              <Icon className="size-4" />
              {label}
            </NavLink>
          ))}
          <Link
            to="/agent-profiles"
            className="ml-auto inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border px-3 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Bot className="size-4" />
            助手配置
          </Link>
        </div>
      </div>

      {section !== 'usage' && (
        <div className="border-b border-border/70 bg-muted/30 px-4 py-2.5 lg:px-6">
          <p className="mx-auto max-w-7xl text-xs leading-5 text-muted-foreground">
            在这里安装和管理可复用资源；到具体智能体的“能力配置”中决定是否启用。
            工作区自带的 CLAUDE.md、.claude/skills 与项目 MCP 不在这里分配。
          </p>
        </div>
      )}

      {section === 'skills' && <SkillsPage />}
      {section === 'mcp' && <McpServersPage />}
      {section === 'plugins' && <PluginsPage />}
      {section === 'usage' && (
        <Suspense
          fallback={
            <div className="mx-auto max-w-7xl p-6 text-sm text-muted-foreground">
              正在加载用量分析…
            </div>
          }
        >
          <UsagePage />
        </Suspense>
      )}
    </div>
  );
}
