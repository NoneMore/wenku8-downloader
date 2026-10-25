import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../http/client.js';
import { ACCOUNT_URL, LOGIN_URL } from '../site/auth.js';
import { CloudflareChallengeError } from '../domain/errors.js';
import { loginAccount } from './login.js';
import * as browserLogin from './browser.js';

const form = `<form action="${LOGIN_URL}?do=submit" method="post"><input name="username"><input name="password" type="password"><input name="action" type="hidden" value="login"></form>`;
const credentials = { username: 'test', password: 'synthetic-test-password' };
afterEach(() => vi.restoreAllMocks());

describe('account login', () => {
  it('starts with Node so direct account login does not require curl', async () => {
    vi.spyOn(HttpClient.prototype, 'text').mockImplementation(function (this: HttpClient, url) {
      expect(this.getTransport()).toBe('node');
      return Promise.resolve(url === LOGIN_URL ? form : '<a href="/logout.php">退出</a>');
    });
    const post = vi.spyOn(HttpClient.prototype, 'postForm').mockResolvedValue('登录成功');
    expect((await loginAccount(credentials)).transport).toBe('node');
    expect(post).toHaveBeenCalledOnce();
  });

  it('hands an HTTP-200 account verification page to the browser without repeating the POST', async () => {
    vi.spyOn(HttpClient.prototype, 'text').mockImplementation((url) =>
      Promise.resolve(url === LOGIN_URL ? form : '<script>window._cf_chl_opt = {};</script>'),
    );
    const post = vi.spyOn(HttpClient.prototype, 'postForm').mockResolvedValue('登录成功');
    const open = vi
      .spyOn(browserLogin, 'loginInBrowser')
      .mockRejectedValue(new Error('browser required'));
    await expect(loginAccount(credentials)).rejects.toThrow('browser required');
    expect(post).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledOnce();
  });
  it('verifies authenticated access using the actual request client before returning a session', async () => {
    const text = vi
      .spyOn(HttpClient.prototype, 'text')
      .mockImplementation((url) =>
        Promise.resolve(url === LOGIN_URL ? form : '<a href="/logout.php">退出</a>'),
      );
    const post = vi.spyOn(HttpClient.prototype, 'postForm').mockResolvedValue('登录成功');
    const session = await loginAccount(credentials);
    expect(post).toHaveBeenCalledOnce();
    expect(text).toHaveBeenCalledWith(ACCOUNT_URL, 'gb18030', undefined);
    expect(session.id).toBeTruthy();
    expect(JSON.stringify(session)).not.toContain(credentials.password);
  });

  it('does not accept success text, a cookie or a redirect alone as proof of account login', async () => {
    vi.spyOn(HttpClient.prototype, 'text').mockImplementation((url) =>
      Promise.resolve(url === LOGIN_URL ? form : '登录成功'),
    );
    vi.spyOn(HttpClient.prototype, 'postForm').mockResolvedValue('登录成功');
    await expect(loginAccount(credentials)).rejects.toThrow(/无法确认/);
  });

  it('reports a wrong password without retries or browser fallback', async () => {
    vi.spyOn(HttpClient.prototype, 'text').mockResolvedValue(form);
    const post = vi.spyOn(HttpClient.prototype, 'postForm').mockResolvedValue('密码错误');
    const open = vi.spyOn(browserLogin, 'loginInBrowser');
    await expect(loginAccount(credentials)).rejects.toThrow(/账号或密码错误/);
    expect(post).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
  });

  it('hands challenges to the browser rather than asking for a Cookie', async () => {
    vi.spyOn(HttpClient.prototype, 'text').mockRejectedValue(
      new CloudflareChallengeError(LOGIN_URL),
    );
    const open = vi
      .spyOn(browserLogin, 'loginInBrowser')
      .mockRejectedValue(new Error('synthetic browser result'));
    const notice = vi.fn();
    await expect(loginAccount(credentials, { onBrowserRequired: notice })).rejects.toThrow(
      'synthetic browser result',
    );
    expect(notice).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledOnce();
  });
});
