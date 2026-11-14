import {
  Info,
  MessageSquare,
  Palette,
  Shield,
  ShieldCheck,
  Bot,
  ServerCog,
  Settings2,
  SlidersHorizontal,
  User,
} from 'lucide-react';

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import type { SettingsTab } from './types';
import type { ReactNode } from 'react';

interface NavItem {
  key: SettingsTab;
  label: string;
  icon: React.ReactNode;
}

const accountItems: NavItem[] = [
  { key: 'device-control', label: '电脑与浏览器', icon: <ServerCog className="size-4" /> },
  { key: 'profile', label: '个人资料', icon: <User className="size-4" /> },
  {
    key: 'preferences',
    label: '常规',
    icon: <Settings2 className="size-4" />,
  },
  {
    key: 'my-channels',
    label: '消息渠道',
    icon: <MessageSquare className="size-4" />,
  },
  { key: 'security', label: '安全与设备', icon: <Shield className="size-4" /> },
];

const systemItems: NavItem[] = [
  {
    key: 'appearance',
    label: '常规与品牌',
    icon: <Palette className="size-4" />,
  },
  {
    key: 'claude',
    label: '模型配置',
    icon: <ShieldCheck className="size-4" />,
  },
  {
    key: 'main-agent',
    label: '主 EvoBot',
    icon: <Bot className="size-4" />,
  },
  {
    key: 'system',
    label: '执行与容量',
    icon: <SlidersHorizontal className="size-4" />,
  },
  {
    key: 'host-integration',
    label: '宿主机集成',
    icon: <ServerCog className="size-4" />,
  },
];

const aboutItem: NavItem = {
  key: 'about',
  label: '关于 EvoBot',
  icon: <Info className="size-4" />,
};

interface SettingsNavProps {
  activeTab?: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  canManageSystemConfig: boolean;
  canManageBilling?: boolean;
  canManageUsers?: boolean;
  isAdmin: boolean;
  mustChangePassword: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  returnFocus?: () => void;
  mode?: 'both' | 'desktop' | 'drawer';
  drawerActions?: ReactNode;
}

export function SettingsNav({
  activeTab,
  onTabChange,
  canManageSystemConfig,
  isAdmin,
  mustChangePassword,
  open,
  onOpenChange,
  returnFocus,
  mode = 'both',
  drawerActions,
}: SettingsNavProps) {
  const system = systemItems.filter((item) => {
    if (item.key === 'main-agent' || item.key === 'host-integration') {
      return isAdmin;
    }
    return canManageSystemConfig;
  });
  const sections = [
    { label: '账户设置', items: accountItems },
    ...(system.length ? [{ label: '高级设置', items: system }] : []),
  ];

  const disabled = (item: NavItem) =>
    mustChangePassword && item.key !== 'security';

  const navigation = (
    <>
      {sections.map((section, index) => (
        <div key={section.label} className={index > 0 ? 'mt-6' : ''}>
          <div className="mb-2 px-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {section.label}
          </div>
          <div className="space-y-1">
            {section.items.map((item) => (
              <button
                key={item.key}
                type="button"
                disabled={disabled(item)}
                onClick={() => {
                  if (disabled(item)) return;
                  onTabChange(item.key);
                  onOpenChange?.(false);
                }}
                className={`flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                  activeTab === item.key
                    ? 'bg-brand-50 font-medium text-primary'
                    : disabled(item)
                      ? 'cursor-not-allowed text-muted-foreground/50'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                }`}
              >
                {item.icon}
                {item.label}
              </button>
            ))}
          </div>
        </div>
      ))}
      <div className="mt-6 border-t border-border pt-4">
        <button
          type="button"
          disabled={mustChangePassword}
          onClick={() => {
            if (mustChangePassword) return;
            onTabChange(aboutItem.key);
            onOpenChange?.(false);
          }}
          className={`flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
            activeTab === aboutItem.key
              ? 'bg-brand-50 font-medium text-primary'
              : mustChangePassword
                ? 'cursor-not-allowed text-muted-foreground/50'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
          }`}
        >
          {aboutItem.icon}
          {aboutItem.label}
        </button>
      </div>
    </>
  );

  return (
    <>
      {mode !== 'drawer' && (
        <nav className="hidden w-56 shrink-0 border-r border-border bg-background px-3 py-6 min-[1101px]:sticky min-[1101px]:top-0 min-[1101px]:block min-[1101px]:h-dvh min-[1101px]:self-start min-[1101px]:overflow-y-auto">
          {navigation}
        </nav>
      )}
      {mode !== 'desktop' && (
        <Sheet open={open} onOpenChange={onOpenChange}>
          <SheetContent
            side="left"
            className="flex flex-col gap-0 p-0 pt-[env(safe-area-inset-top)] data-[side=left]:w-[min(88vw,320px)]"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              requestAnimationFrame(() => returnFocus?.());
            }}
          >
            <SheetHeader className="px-4 pb-4 pt-5 pr-16">
              <SheetTitle className="text-base">设置</SheetTitle>
              <SheetDescription className="sr-only">
                选择账户、系统配置或管理后台中的设置页面
              </SheetDescription>
            </SheetHeader>
            <nav className="min-h-0 flex-1 overflow-y-auto px-3 pb-28">
              {drawerActions}
              {navigation}
            </nav>
          </SheetContent>
        </Sheet>
      )}
    </>
  );
}
