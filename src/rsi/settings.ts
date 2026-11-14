import {
  getRegisteredGroup,
  getRouterState,
  setRouterState,
} from '../db.js';
import { GoalConflict } from '../personal-agent/goal-store.js';

function settingsKey(workspaceJid: string): string {
  return `rsi_auto:${workspaceJid}`;
}

function assertWorkspaceExists(workspaceJid: string): void {
  if (!getRegisteredGroup(workspaceJid)) {
    throw new GoalConflict('GOAL_NOT_FOUND', 'Workspace not found');
  }
}

export function getAutoRetry(workspaceJid: string): boolean {
  assertWorkspaceExists(workspaceJid);
  return getRouterState(settingsKey(workspaceJid)) === '1';
}

export function setAutoRetry(workspaceJid: string, enabled: boolean): void {
  assertWorkspaceExists(workspaceJid);
  setRouterState(settingsKey(workspaceJid), enabled ? '1' : '0');
}
