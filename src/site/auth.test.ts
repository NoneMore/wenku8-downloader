import { describe, expect, it } from 'vitest';
import {
  LOGIN_URL,
  encodeLoginForm,
  isAuthenticatedPage,
  isLoginRequired,
  loginFailure,
  parseLoginForm,
} from './auth.js';

// Synthetic structure matches field names and action observed on the live login page.
const loginHtml = `<form method="post" action="${LOGIN_URL}?do=submit">
  <input name="username"><input name="password" type="password">
  <input type="hidden" name="action" value="login">
  <select name="usecookie"><option value="0">浏览器进程</option><option value="86400">一天</option></select>
  <input type="submit" name="submit" value=" 登 录 "></form>`;
const accountHtml = '<a href="/logout.php">退出登录</a><a href="/userdetail.php">个人信息</a>';

describe('site authentication', () => {
  it('selects a valid login form after password recovery or account-settings forms', () => {
    const page =
      '<form action="/recover.php"><input name="password" type="password"></form><form method="post" action="/useredit.php"><input name="username"><input name="password" type="password"></form>' +
      loginHtml;
    const selected = parseLoginForm(page)!;
    expect(selected.formIndex).toBe(2);
    expect(selected.url).toBe(`${LOGIN_URL}?do=submit`);
  });
  it('retains the form state and encodes Chinese credentials as GBK', () => {
    const form = parseLoginForm(loginHtml)!;
    expect(form.url).toBe(`${LOGIN_URL}?do=submit`);
    expect(form.fields).toContainEqual(['action', 'login']);
    expect(encodeLoginForm(form, '测试', 'a+b&c')).toContain(
      'username=%B2%E2%CA%D4&password=a%2Bb%26c',
    );
    expect(encodeLoginForm(form, 'test', 'a b')).toContain('password=a+b');
    expect(() => encodeLoginForm(form, 'test', '😀')).toThrow(/GBK/);
  });

  it('rejects untrusted form destinations and preserves captcha interaction', () => {
    expect(() =>
      parseLoginForm(loginHtml.replace(LOGIN_URL, 'https://example.org/login.php')),
    ).toThrow(/不受信任/);
    expect(() => parseLoginForm(loginHtml.replace('https:', 'http:'))).toThrow(/不受信任/);
    expect(
      parseLoginForm(loginHtml.replace('</form>', '<input name="checkcode"></form>'))
        ?.needsVerification,
    ).toBe(true);
  });

  it('requires positive account evidence and identifies HTTP-200 login failures', () => {
    expect(isAuthenticatedPage(accountHtml)).toBe(true);
    const settings = `${accountHtml}<form action="/useredit.php" method="post"><input name="username"><input name="password" type="password"></form>`;
    expect(isAuthenticatedPage(settings)).toBe(true);
    expect(isLoginRequired(settings)).toBe(false);
    expect(isAuthenticatedPage('<p>登录成功</p>')).toBe(false);
    expect(isAuthenticatedPage('<a href="https://example.org/logout.php">退出</a>')).toBe(false);
    expect(isAuthenticatedPage(loginHtml + accountHtml)).toBe(false);
    expect(isLoginRequired(loginHtml)).toBe(true);
    expect(isLoginRequired('<title>提示信息</title><body>您尚未登录，请先登录</body>')).toBe(true);
    expect(isLoginRequired('<body>您还没有登录，<a href="/login.php">请先登录</a></body>')).toBe(
      true,
    );
    expect(
      isLoginRequired(
        '<title>小说章节</title><div id="content">屏幕上出现了“您尚未登录，请先登录”的文字。</div>',
      ),
    ).toBe(false);
    expect(isLoginRequired('<p>小说登录世界</p>')).toBe(false);
    expect(loginFailure('密码错误')).toMatch(/账号或密码错误/);
    expect(loginFailure('账号已经禁用')).toMatch(/账号受限/);
  });
});
