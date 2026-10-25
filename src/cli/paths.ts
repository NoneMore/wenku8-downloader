import os from 'node:os';
import path from 'node:path';

const APP_NAME = 'wenku8';

export interface UserDirectoryOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
}

export function userDownloadsDirectory(options: UserDirectoryOptions = {}): string {
  return path.join(userConfigDirectory(options), 'downloads');
}

export function userWorkspaceDirectory(options: UserDirectoryOptions = {}): string {
  return path.join(userConfigDirectory(options), 'workspace');
}

export function userConfigDirectory(options: UserDirectoryOptions = {}): string {
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const platform = options.platform ?? process.platform;
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', APP_NAME);
  if (platform === 'win32') {
    return path.join(env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), APP_NAME);
  }
  return path.join(env.XDG_CONFIG_HOME ?? path.join(home, '.config'), APP_NAME);
}
