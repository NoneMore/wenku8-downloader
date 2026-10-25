import { load } from 'cheerio';
import iconv from 'iconv-lite';

export const SITE_ORIGIN = 'https://www.wenku8.net';
export const LOGIN_URL = `${SITE_ORIGIN}/login.php`;
export const ACCOUNT_URL = `${SITE_ORIGIN}/userdetail.php`;

export interface LoginForm {
  formIndex: number;
  url: string;
  fields: Array<[string, string]>;
  needsVerification: boolean;
}

export function parseLoginForm(html: string): LoginForm | undefined {
  const $ = load(html);
  const forms = $('form').toArray();
  const candidates = forms.filter(
    (element) =>
      $(element).find('[name="username"]').length &&
      $(element).find('input[type="password"][name="password"]').length,
  );
  if (!candidates.length) return undefined;
  const selected = candidates.find((element) => {
    const form = $(element);
    try {
      const target = new URL(form.attr('action') || LOGIN_URL, LOGIN_URL);
      return (
        target.origin === SITE_ORIGIN &&
        target.pathname === '/login.php' &&
        form.attr('method')?.toLowerCase() === 'post'
      );
    } catch {
      return false;
    }
  });
  if (!selected) {
    throw new Error('站点登录表单目标不受信任，已停止发送认证信息');
  }
  const form = $(selected);
  const url = new URL(form.attr('action') || LOGIN_URL, LOGIN_URL);
  const fields: Array<[string, string]> = [];
  form.find('input[type="hidden"]').each((_index, element) => {
    const name = $(element).attr('name');
    if (name && !['username', 'password'].includes(name))
      fields.push([name, $(element).attr('value') || '']);
  });
  const duration = form.find('select[name="usecookie"] option:selected').first();
  const first = form.find('select[name="usecookie"] option').first();
  if (first.length)
    fields.push(['usecookie', duration.attr('value') ?? first.attr('value') ?? '0']);
  const submit = form.find('input[type="submit"][name]').first();
  if (submit.length) fields.push([submit.attr('name')!, submit.attr('value') ?? '']);
  return {
    formIndex: forms.indexOf(selected),
    url: url.href,
    fields,
    needsVerification:
      form
        .find('input')
        .toArray()
        .some((element) =>
          /captcha|checkcode|verify|validate/i.test($(element).attr('name') ?? ''),
        ) ||
      form.find('iframe[src*="challenges.cloudflare.com"], .cf-turnstile, .g-recaptcha').length > 0,
  };
}

export function encodeLoginForm(form: LoginForm, username: string, password: string): string {
  const fields: Array<[string, string]> = [
    ...form.fields,
    ['username', username],
    ['password', password],
  ];
  return fields.map(([key, value]) => `${encodeGbk(key)}=${encodeGbk(value)}`).join('&');
}

function encodeGbk(value: string): string {
  const encoded = iconv.encode(value, 'gbk');
  if (iconv.decode(encoded, 'gbk') !== value)
    throw new Error('账号或密码包含站点 GBK 编码无法表示的字符');
  return Array.from(encoded, (byte) =>
    /[A-Za-z0-9*._-]/.test(String.fromCharCode(byte))
      ? String.fromCharCode(byte)
      : byte === 32
        ? '+'
        : `%${byte.toString(16).padStart(2, '0').toUpperCase()}`,
  ).join('');
}

export function isAuthenticatedPage(html: string): boolean {
  const $ = load(html);
  if (hasLoginForm($)) return false;
  return $('a[href]')
    .toArray()
    .some((element) => {
      try {
        const url = new URL($(element).attr('href')!, SITE_ORIGIN);
        return url.origin === SITE_ORIGIN && url.pathname === '/logout.php';
      } catch {
        return false;
      }
    });
}

export function isLoginRequired(html: string): boolean {
  const $ = load(html);
  const message =
    /(?:您|你)(?:(?:还|尚)?未|(?:还|尚)?没有)(?:登录|登錄)|请先(?:登录|登錄)|請先登錄/.test(
      $('body').text(),
    );
  const loginLink = $('a[href]')
    .toArray()
    .some((element) => {
      try {
        const target = new URL($(element).attr('href')!, SITE_ORIGIN);
        return target.origin === SITE_ORIGIN && target.pathname === '/login.php';
      } catch {
        return false;
      }
    });
  return (
    hasLoginForm($) ||
    (!isAuthenticatedPage(html) &&
      message &&
      (loginLink || /提示信息|错误信息|錯誤訊息/.test($('title').text())))
  );
}

function hasLoginForm($: ReturnType<typeof load>): boolean {
  return $('form')
    .toArray()
    .some((element) => {
      const form = $(element);
      if (
        !form.find('[name="username"]').length ||
        !form.find('input[type="password"][name="password"]').length
      )
        return false;
      try {
        const target = new URL(form.attr('action') || LOGIN_URL, LOGIN_URL);
        return target.origin === SITE_ORIGIN && target.pathname === '/login.php';
      } catch {
        return false;
      }
    });
}

export function loginFailure(html: string): string | undefined {
  const $ = load(html);
  $('script, style').remove();
  const text = $.text();
  if (/(?:用户|账号|帳號).{0,16}(?:禁用|封禁|锁定|鎖定)|登录次数.{0,16}(?:多|限制)/.test(text))
    return '账号受限或登录次数过多，请按站点提示处理后重试';
  if (
    /(?:用户|用户名|账号).{0,16}(?:不存在|错误|不正确)|密码.{0,16}(?:错误|不正确)|登录失败/.test(
      text,
    )
  )
    return '账号或密码错误，请重新运行 `wenku8 login`';
  return undefined;
}

export function isVerificationPage(html: string): boolean {
  return (
    isChallengePage(html) ||
    /cf-mitigated|challenge-platform|cf-turnstile|g-recaptcha|验证码|驗證碼/.test(html)
  );
}

export function isChallengePage(html: string): boolean {
  const $ = load(html);
  return (
    $('#challenge-form, .cf-turnstile, iframe[src*="challenges.cloudflare.com"]').length > 0 ||
    $('script')
      .toArray()
      .some((element) => {
        const script = $(element);
        return (
          (script.attr('src') ?? '').includes('/cdn-cgi/challenge-platform/') ||
          /(?:window\.)?_cf_chl_opt\s*=/.test(script.html() ?? '')
        );
      })
  );
}
