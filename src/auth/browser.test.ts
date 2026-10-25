import { chromium, type BrowserContext } from 'playwright';
import { CookieJar } from 'tough-cookie';
import iconv from 'iconv-lite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../http/client.js';
import { ACCOUNT_URL, LOGIN_URL, SITE_ORIGIN } from '../site/auth.js';
import { browserCookiesToJar, loginInBrowser } from './browser.js';

const accountHtml = '<a href="/logout.php">退出</a>';
const credentials = { username: '测试', password: 'synthetic-test-password' };
const contexts: BrowserContext[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    contexts.splice(0).map(async (context) => {
      await context.close().catch(() => undefined);
      await context.browser()?.close();
    }),
  );
});

async function contextFor(form: string, responseHtml = accountHtml) {
  const channel = process.env.WENKU8_TEST_BROWSER;
  const browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
  const context = await browser.newContext();
  contexts.push(context);
  const posts: string[] = [];
  await context.route('**/*', async (route) => {
    if (!route.request().url().startsWith(`${SITE_ORIGIN}/`)) {
      await route.abort();
      return;
    }
    const posted = route.request().method() === 'POST';
    if (posted) posts.push(route.request().postData() ?? '');
    await route.fulfill({
      status: 200,
      headers: {
        'content-type': 'text/html; charset=gbk',
        ...(posted
          ? { 'set-cookie': 'synthetic_session=browser-test; Path=/; Secure; HttpOnly' }
          : {}),
      },
      body: iconv.encode(posted ? responseHtml : form, 'gbk'),
    });
  });
  return { context, posts };
}

function form(extra = '') {
  return `<meta charset="gbk"><form method="post" action="${LOGIN_URL}?do=submit"><input name="username"><input type="password" name="password"><input type="hidden" name="action" value="login">${extra}<input type="submit" value="登录"></form>`;
}

describe('browser authentication', () => {
  it('retains the Node transport when curl cannot use the exported browser session', async () => {
    const { context } = await contextFor(form());
    vi.spyOn(HttpClient.prototype, 'text').mockImplementation(function (this: HttpClient) {
      return Promise.resolve(this.getTransport() === 'curl' ? form() : accountHtml);
    });
    const session = await loginInBrowser(credentials, new CookieJar(), {
      createContext: () => Promise.resolve(context),
    });
    expect(session.transport).toBe('node');
    expect(context.pages()).toHaveLength(0);
  }, 20_000);

  it('keeps waiting when page content changes during a challenge redirect', async () => {
    const { context } = await contextFor(form());
    const newPage = context.newPage.bind(context);
    vi.spyOn(context, 'newPage').mockImplementation(async () => {
      const page = await newPage();
      const content = page.content.bind(page);
      vi.spyOn(page, 'content')
        .mockRejectedValueOnce(
          new Error(
            'Unable to retrieve content because the page is navigating and changing the content.',
          ),
        )
        .mockImplementation(content);
      return page;
    });
    vi.spyOn(HttpClient.prototype, 'text').mockResolvedValue(accountHtml);
    await expect(
      loginInBrowser(credentials, new CookieJar(), {
        createContext: () => Promise.resolve(context),
      }),
    ).resolves.toHaveProperty('id');
  }, 20_000);

  it('submits the real form in its encoding, exports scoped cookies, verifies the CLI and cleans up', async () => {
    const { context, posts } = await contextFor(form());
    const verify = vi.spyOn(HttpClient.prototype, 'text').mockImplementation(function (
      this: HttpClient,
      url,
    ) {
      expect(url).toBe(ACCOUNT_URL);
      expect(this.cookieJar.getCookieStringSync(url)).toBe('synthetic_session=browser-test');
      expect(this.getUserAgent()).toContain('Chrome');
      return Promise.resolve(accountHtml);
    });
    const session = await loginInBrowser(credentials, new CookieJar(), {
      createContext: () => Promise.resolve(context),
    });
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain('username=%B2%E2%CA%D4');
    expect(verify).toHaveBeenCalledOnce();
    expect(session.cookieJar.getCookieStringSync('http://www.wenku8.net/')).toBe('');
    expect(session.cookieJar.getCookieStringSync('https://example.org/')).toBe('');
    expect(context.pages()).toHaveLength(0);
    expect(context.browser()?.isConnected()).toBe(false);
  }, 20_000);

  it('waits for manual captcha input and automatically receives the completed login', async () => {
    const { context, posts } = await contextFor(form('<input name="checkcode">'));
    vi.spyOn(HttpClient.prototype, 'text').mockResolvedValue(accountHtml);
    const login = loginInBrowser(credentials, new CookieJar(), {
      createContext: () => Promise.resolve(context),
    });
    const page = await context.waitForEvent('page');
    await page.locator('[name=password]').waitFor();
    await expect
      .poll(() => page.locator('[name=password]').inputValue())
      .toBe(credentials.password);
    expect(posts).toHaveLength(0);
    await page.locator('[name=checkcode]').fill('synthetic-human-code');
    await page.locator('[type=submit]').click();
    await login;
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain('checkcode=synthetic-human-code');
  }, 20_000);

  it('rejects a browser session that cannot authenticate through the CLI transport', async () => {
    const { context } = await contextFor(form());
    vi.spyOn(HttpClient.prototype, 'text').mockResolvedValue(form());
    await expect(
      loginInBrowser(credentials, new CookieJar(), {
        createContext: () => Promise.resolve(context),
      }),
    ).rejects.toThrow(/未能交接/);
    expect(context.pages()).toHaveLength(0);
  }, 20_000);

  it('reports wrong passwords without retrying or leaking filled credentials', async () => {
    const { context, posts } = await contextFor(form(), '密码错误');
    await expect(
      loginInBrowser(credentials, new CookieJar(), {
        createContext: () => Promise.resolve(context),
      }),
    ).rejects.toThrow('账号或密码错误');
    expect(posts).toHaveLength(1);
    expect(context.pages()).toHaveLength(0);
  }, 20_000);

  it('cancels verification and cleans up without requiring a Cookie', async () => {
    const { context } = await contextFor(form('<input name="checkcode">'));
    const cancel = new AbortController();
    const result = loginInBrowser(credentials, new CookieJar(), {
      signal: cancel.signal,
      createContext: () => Promise.resolve(context),
    });
    const rejection = expect(result).rejects.toThrow('登录已取消');
    const page = await context.waitForEvent('page');
    await page.locator('[name=password]').waitFor();
    cancel.abort();
    await rejection;
    expect(context.pages()).toHaveLength(0);
  }, 20_000);

  it('retains host-only, path, expiry and secure restrictions on exported cookies', () => {
    const base = {
      value: 'synthetic',
      domain: 'www.wenku8.net',
      path: '/private',
      secure: true,
      httpOnly: true,
      expires: -1,
      sameSite: 'Lax' as const,
    };
    const jar = browserCookiesToJar([
      { ...base, name: 'session' },
      { ...base, name: 'expired', expires: 1 },
      { ...base, name: 'external', domain: 'example.org' },
    ]);
    expect(jar.getCookieStringSync('https://www.wenku8.net/private/page')).toBe(
      'session=synthetic',
    );
    expect(jar.getCookieStringSync('https://sub.www.wenku8.net/private/page')).toBe('');
    expect(jar.getCookieStringSync('https://www.wenku8.net/public')).toBe('');
    expect(jar.getCookieStringSync('http://www.wenku8.net/private/page')).toBe('');
    expect(jar.getCookieStringSync('https://example.org/private/page')).toBe('');
  });
});
