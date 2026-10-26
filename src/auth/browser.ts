import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Cookie as BrowserCookie,
} from 'playwright';
import { Cookie, CookieJar } from 'tough-cookie';
import { HttpClient } from '../http/client.js';
import {
  ACCOUNT_URL,
  LOGIN_URL,
  SITE_ORIGIN,
  isAuthenticatedPage,
  loginFailure,
  parseLoginForm,
} from '../site/auth.js';
import {
  LOGIN_TIMEOUT_MS,
  verificationFailure,
  verifySession,
  type Credentials,
  type LoginOptions,
} from './login.js';
import type { AccountSession } from './session.js';
import { resolveProxy } from '../http/proxy.js';
import { NonRetryableHttpError } from '../domain/errors.js';

interface BrowserLoginOptions extends LoginOptions {
  createContext?: (
    signal: AbortSignal,
    proxy: { server: string; bypass: string },
  ) => Promise<BrowserContext>;
}

class BrowserLoginError extends Error {}

export async function loginInBrowser(
  credentials: Credentials,
  jar: CookieJar,
  options: BrowserLoginOptions = {},
): Promise<AccountSession> {
  const signal = AbortSignal.any([
    AbortSignal.timeout(LOGIN_TIMEOUT_MS),
    ...(options.signal ? [options.signal] : []),
  ]);
  let context: BrowserContext | undefined;
  let browser: Browser | null | undefined;
  const abort = () => {
    void context?.close().catch(() => undefined);
  };
  signal.addEventListener('abort', abort, { once: true });
  let submitted = false;
  let phase = '初始化浏览器';
  try {
    signal.throwIfAborted();
    const server = resolveProxy(LOGIN_URL, options.proxy) || 'direct://';
    const bypass =
      options.proxy === undefined
        ? process.env.no_proxy || process.env.NO_PROXY || ''
        : '<-loopback>';
    context = await (options.createContext ?? openLoginContext)(signal, { server, bypass });
    browser = context.browser();
    signal.throwIfAborted();
    context.setDefaultTimeout(5_000);
    // Never submit a top-level login form to another host or an insecure URL.
    await context.route('**/*', async (route) => {
      const request = route.request();
      if (
        request.isNavigationRequest() &&
        request.frame() === request.frame().page().mainFrame() &&
        request.method() === 'POST'
      ) {
        const target = new URL(request.url());
        if (target.origin !== SITE_ORIGIN || target.pathname !== '/login.php') {
          await route.abort();
          return;
        }
      }
      await route.fallback();
    });
    const cookies = (jar.serializeSync()?.cookies ?? []).flatMap((data) => {
      const cookie = Cookie.fromJSON(data);
      if (!cookie?.key || !cookie.domain || !isSiteDomain(cookie.domain)) return [];
      return [
        {
          name: cookie.key,
          value: cookie.value,
          domain: cookie.hostOnly ? cookie.domain : `.${cookie.domain}`,
          path: cookie.path ?? '/',
          secure: cookie.secure,
          httpOnly: cookie.httpOnly,
          ...(cookie.expires instanceof Date ? { expires: cookie.expires.getTime() / 1000 } : {}),
        },
      ];
    });
    await context.addCookies(cookies);
    const page = await context.newPage();
    phase = '打开登录页';
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    while (!page.isClosed()) {
      signal.throwIfAborted();
      const url = new URL(page.url());
      if (url.origin !== SITE_ORIGIN)
        throw new BrowserLoginError('浏览器登录离开了受信任站点，已停止登录');
      phase = submitted ? '等待登录与验证结果' : '等待登录表单';
      let html: string;
      try {
        html = await page.content();
      } catch (error) {
        // Cloudflare and the site's success page both navigate asynchronously.
        if (
          error instanceof Error &&
          /navigat|Execution context was destroyed|Cannot find context/i.test(error.message) &&
          !page.isClosed()
        ) {
          await delay(100, undefined, { signal });
          continue;
        }
        throw error;
      }
      const failure = submitted ? loginFailure(html) : undefined;
      if (failure) throw new BrowserLoginError(failure);
      if (isAuthenticatedPage(html)) {
        const userAgent = await page.evaluate(() => navigator.userAgent);
        const snapshot = browserCookiesToJar(await context.cookies());
        phase = '检查 CLI 会话交接';
        const failures: string[] = [];
        for (const preferCurl of [true, false]) {
          const cookieJar = await snapshot.clone();
          const http = new HttpClient({
            ...(options.proxy !== undefined ? { proxy: options.proxy } : {}),
            cookieJar,
            userAgent,
            preferCurl,
            allowCurlFallback: false,
            retries: 0,
          });
          try {
            await verifySession(http, signal);
            return { id: randomUUID(), userAgent, transport: http.getTransport(), cookieJar };
          } catch (error) {
            signal.throwIfAborted();
            if (error instanceof NonRetryableHttpError) throw error;
            failures.push(`${preferCurl ? 'curl' : 'Node'}：${verificationFailure(error)}`);
          }
        }
        throw new BrowserLoginError(
          `浏览器登录态未能交接给 CLI（${failures.join('；')}）。请重新运行 \`wenku8 login\``,
        );
      }
      const form = parseLoginForm(html);
      if (form && !submitted) {
        // Preserve native form submission so the browser applies the site's GBK encoding.
        const element = page.locator('form').nth(form.formIndex);
        phase = '填写账号';
        await element.locator('[name="username"]').fill(credentials.username);
        phase = '填写密码';
        await element.locator('[name="password"]').fill(credentials.password);
        submitted = true;
        phase = '提交登录表单';
        if (!form.needsVerification)
          await element.locator('[type="submit"]').first().click({ noWaitAfter: true });
      } else if (submitted && /登录成功|登錄成功/.test(html) && !form) {
        phase = '打开账号页面';
        await page.goto(ACCOUNT_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      }
      await delay(500, undefined, { signal });
    }
    throw new BrowserLoginError('登录浏览器已关闭，登录未完成；请重新运行 `wenku8 login`');
  } catch (error) {
    if (signal.aborted)
      throw new Error(
        signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError'
          ? '浏览器登录等待超过 5 分钟，请重新运行 `wenku8 login`'
          : '登录已取消',
      );
    if (error instanceof NonRetryableHttpError) throw error;
    // Playwright call logs can contain filled passwords or rendered page content.
    if (error instanceof BrowserLoginError) throw error;
    const category =
      error instanceof Error && error.name === 'TimeoutError' ? '等待超时' : '浏览器操作失败';
    throw new Error(`浏览器登录未完成（${phase}：${category}），请重新运行 \`wenku8 login\``);
  } finally {
    signal.removeEventListener('abort', abort);
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}

async function openLoginContext(
  signal: AbortSignal,
  proxy: { server: string; bypass: string },
): Promise<BrowserContext> {
  let browser: Browser | undefined;
  for (const channel of ['chrome', 'msedge', undefined]) {
    signal.throwIfAborted();
    try {
      browser = await chromium.launch({
        headless: false,
        proxy,
        ...(channel ? { channel } : {}),
        timeout: 15_000,
      });
      signal.throwIfAborted();
      return await browser.newContext({ acceptDownloads: false });
    } catch {
      await browser?.close().catch(() => undefined);
      signal.throwIfAborted();
    }
  }
  throw new Error(
    '无法启动登录浏览器。请安装 Chrome 或 Edge，或执行 `npx playwright install chromium`，并在有图形界面的环境重试',
  );
}

export function browserCookiesToJar(cookies: BrowserCookie[]): CookieJar {
  const jar = new CookieJar();
  for (const data of cookies) {
    const domain = data.domain.replace(/^\./, '');
    if (!isSiteDomain(domain)) continue;
    const cookie = new Cookie({
      key: data.name,
      value: data.value,
      domain,
      hostOnly: !data.domain.startsWith('.'),
      path: data.path,
      secure: data.secure,
      httpOnly: data.httpOnly,
      ...(data.expires > 0 ? { expires: new Date(data.expires * 1000) } : {}),
      sameSite: data.sameSite.toLowerCase(),
    });
    jar.setCookieSync(cookie, `https://${domain}${data.path}`);
  }
  return jar;
}

function isSiteDomain(domain: string): boolean {
  return domain === 'wenku8.net' || domain.endsWith('.wenku8.net');
}
