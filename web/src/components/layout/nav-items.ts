import {
  MessageCircle,
  Clock4,
  Bot,
  Puzzle,
  BarChart3,
  Settings,
  Target,
  Users,
} from 'lucide-react';
import { BOT_FIRST_HOME_ENABLED } from '../../utils/bot-first';

interface NavItem {
  path: string;
  icon: typeof MessageCircle;
  label: string;
  hideOnMobile?: boolean;
}

export function productNavItems(goalsEnabled: boolean, botName = 'EvoBot') {
  return [
    {
      path: BOT_FIRST_HOME_ENABLED ? '/bots' : '/chat',
      icon: Bot,
      label: botName,
      section: '',
    },
    ...(BOT_FIRST_HOME_ENABLED
      ? [
          {
            path: '/bots?view=team',
            icon: Users,
            label: '我的助手',
            section: 'MY TEAM',
          },
        ]
      : []),
    {
      path: '/bot-groups',
      icon: MessageCircle,
      label: '团队群聊',
      section: BOT_FIRST_HOME_ENABLED ? '' : 'MY TEAM',
    },
    {
      path: goalsEnabled ? '/goals' : '/tasks',
      icon: Target,
      label: '进化与工作',
      section: 'WORK',
    },
    {
      path: '/capabilities',
      icon: Puzzle,
      label: '能力与用量',
      section: '',
    },
    { path: '/chat', icon: Clock4, label: '最近会话', section: '' },
  ].filter(
    (item, index, items) =>
      items.findIndex((other) => other.path === item.path) === index,
  );
}
export function mobileNavItems(goalsEnabled: boolean, botName = 'EvoBot') {
  return [
    {
      path: goalsEnabled ? '/goals' : '/tasks',
      icon: Target,
      label: '工作',
    },
    {
      path: BOT_FIRST_HOME_ENABLED ? '/bots' : '/chat',
      icon: Bot,
      label: botName,
    },
    { path: '/bot-groups', icon: MessageCircle, label: '群聊' },
    { path: '/capabilities', icon: Puzzle, label: '能力' },
    { path: '/settings?tab=profile', icon: Settings, label: '设置' },
  ];
}
export { productNavActive, workRailPath } from './nav-routing';

export const baseNavItems: NavItem[] = [
  { path: '/goals', icon: Target, label: '进化与工作' },
  { path: '/bots', icon: Bot, label: '我的助手' },
  { path: '/chat', icon: MessageCircle, label: '对话' },
  { path: '/bot-groups', icon: Users, label: '团队群聊' },
  { path: '/agent-profiles', icon: Bot, label: '助手配置', hideOnMobile: true },
  { path: '/capabilities', icon: Puzzle, label: '能力与用量' },
  { path: '/tasks', icon: Clock4, label: '定时任务' },
  { path: '/usage', icon: BarChart3, label: '用量', hideOnMobile: true },
  { path: '/settings', icon: Settings, label: '设置' },
];

export function filterNavItems(_billingEnabled = false, goalsEnabled = false) {
  return baseNavItems
    .filter((item) => item.path !== '/bots' || BOT_FIRST_HOME_ENABLED)
    .filter((item) => goalsEnabled || item.path !== '/goals');
}
