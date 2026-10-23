import type { GitBridge } from '../src/app/bridge';
export function findGit(): Promise<string | undefined>;
export const status: GitBridge['status'];
export const checkRemote: GitBridge['check'];
export function setup(
  dir: string,
  url: string,
  opts?: { rename?: boolean; combine?: boolean },
): ReturnType<GitBridge['setup']> extends Promise<infer R>
  ? Promise<R extends { name: string } ? Omit<R, 'name'> : R>
  : never;
export const sync: GitBridge['sync'];
