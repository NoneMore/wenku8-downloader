import { randomUUID } from 'node:crypto';
import { CookieJar } from 'tough-cookie';
import { HttpClient } from '../http/client.js';
import { CloudflareChallengeError, HttpStatusError } from '../domain/errors.js';
import {
  ACCOUNT_URL,
  LOGIN_URL,
  encodeLoginForm,
  isAuthenticatedPage,
  isLoginRequired,
  isVerificationPage,
  loginFailure,
  parseLoginForm,
} from '../site/auth.js';
import type { AccountSession } from './session.js';
import { isProxyError, type ProxyOptions } from '../http/proxy.js';

export const LOGIN_TIMEOUT_MS = 5 * 60_000;

export interface Credentials {
  username: string;
  password: string;
}

export interface LoginOptions extends ProxyOptions {
  signal?: AbortSignal;
  onBrowserRequired?: () => void;
}

export async function loginAccount(
  credentials: Credentials,
  options: LoginOptions = {},
): Promise<AccountSession> {
  if (!credentials.username.trim() || !credentials.password) throw new Error('账号和密码不能为空');
  const cookieJar = new CookieJar();
  const http = new HttpClient({
    ...options,
    cookieJar,
    preferCurl: false,
    allowCurlFallback: false,
    retries: 0,
  });
  try {
    const html = await http.text(LOGIN_URL, 'gb18030', options.signal);
    const form = parseLoginForm(html);
    if (form && !form.needsVerification) {
      const result = await http.postForm(
        form.url,
        encodeLoginForm(form, credentials.username.trim(), credentials.password),
        options.signal,
      );
      const failure = loginFailure(result);
      if (failure) throw new Error(failure);
      if (!isVerificationPage(result)) {
        await verifySession(http, options.signal);
        return {
          id: randomUUID(),
          userAgent: http.getUserAgent(),
          transport: http.getTransport(),
          cookieJar,
        };
      }
    } else if (!form && !isVerificationPage(html)) {
      throw new Error('无法识别站点登录表单，请检查站点是否变更');
    }
  } catch (error) {
    if (!(error instanceof CloudflareChallengeError)) throw error;
  } finally {
    await http.close();
  }
  options.signal?.throwIfAborted();
  options.onBrowserRequired?.();
  const { loginInBrowser } = await import('./browser.js');
  return loginInBrowser(credentials, cookieJar, options);
}

export async function verifySession(http: HttpClient, signal?: AbortSignal): Promise<void> {
  const html = await http.text(ACCOUNT_URL, 'gb18030', signal);
  if (isAuthenticatedPage(html)) return;
  if (isVerificationPage(html)) throw new CloudflareChallengeError(ACCOUNT_URL);
  throw new Error(
    isLoginRequired(html)
      ? '账号页面仍要求登录，请重新运行 `wenku8 login`'
      : '无法确认账号登录状态：账号页面未提供已登录证据，请重新运行 `wenku8 login`',
  );
}

export function verificationFailure(error: unknown): string {
  if (isProxyError(error)) return error.message;
  if (error instanceof CloudflareChallengeError) return 'Cloudflare 仍拦截 CLI 请求';
  if (error instanceof HttpStatusError) return `账号页面返回 HTTP ${error.status}`;
  if (error instanceof Error && error.message.startsWith('账号页面仍要求登录'))
    return '账号页面仍要求登录';
  if (error instanceof Error && error.message.startsWith('无法确认账号登录状态'))
    return '账号页面缺少已登录证据';
  return '网络或传输失败';
}
