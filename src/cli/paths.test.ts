import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { userConfigDirectory, userDownloadsDirectory, userWorkspaceDirectory } from './paths.js';
import { sessionPath } from '../auth/session.js';

describe('user directories', () => {
  it('uses platform-specific paths for managed sessions', () => {
    expect(sessionPath({ home: '/home/me', platform: 'linux', env: {} })).toBe(
      path.join('/home/me', '.config', 'wenku8', 'session.json'),
    );
    expect(
      sessionPath({ home: '/home/me', platform: 'linux', env: { XDG_CONFIG_HOME: '/tmp/config' } }),
    ).toBe(path.join('/tmp/config', 'wenku8', 'session.json'));
    expect(sessionPath({ home: '/Users/me', platform: 'darwin', env: {} })).toBe(
      path.join('/Users/me', 'Library', 'Application Support', 'wenku8', 'session.json'),
    );
    expect(
      sessionPath({
        home: 'C:\\Users\\me',
        platform: 'win32',
        env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' },
      }),
    ).toBe(path.join('C:\\Users\\me\\AppData\\Roaming', 'wenku8', 'session.json'));
  });

  it('preserves download and workspace directories', () => {
    const options = { home: '/Users/me', platform: 'darwin' as const, env: {} };
    expect(userConfigDirectory(options)).toBe(
      path.join('/Users/me', 'Library', 'Application Support', 'wenku8'),
    );
    expect(userDownloadsDirectory(options)).toBe(
      path.join('/Users/me', 'Library', 'Application Support', 'wenku8', 'downloads'),
    );
    expect(userWorkspaceDirectory(options)).toBe(
      path.join('/Users/me', 'Library', 'Application Support', 'wenku8', 'workspace'),
    );
  });
});
