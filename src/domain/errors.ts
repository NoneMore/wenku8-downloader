export class Wenku8Error extends Error {
  constructor(
    message: string,
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ParseError extends Wenku8Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'PARSE_ERROR', options);
  }
}

export class IncompleteBookError extends Wenku8Error {
  constructor(readonly issues: string[]) {
    super(`Book is incomplete:\n${issues.map((issue) => `- ${issue}`).join('\n')}`, 'INCOMPLETE');
  }
}

export class CopyrightUnavailableError extends Wenku8Error {
  constructor(
    readonly title: string,
    readonly url: string,
  ) {
    super(`《${title}》因版权问题，文库不再提供该章节阅读：${url}`, 'COPYRIGHT_UNAVAILABLE');
  }
}

export class HttpStatusError extends Wenku8Error {
  constructor(
    readonly url: string,
    readonly status: number,
  ) {
    super(`HTTP ${status} for ${url}`, 'HTTP_STATUS');
  }
}

export class CloudflareChallengeError extends Wenku8Error {
  constructor(readonly url: string) {
    super(
      `站点对 ${url} 返回了 Cloudflare challenge。请运行 \`wenku8 login\`，按提示在自动打开的浏览器中完成验证后重试。`,
      'CLOUDFLARE_CHALLENGE',
    );
  }
}

export class AuthenticationRequiredError extends Wenku8Error {
  constructor() {
    super('登录态已失效或尚未登录，请运行 `wenku8 login` 后重试', 'AUTH_REQUIRED');
  }
}
