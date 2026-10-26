import { describe, expect, it, vi } from 'vitest';
import { Wenku8Client } from './client.js';
import { AuthenticationRequiredError, CloudflareChallengeError } from '../domain/errors.js';
import { NonRetryableHttpError } from '../domain/errors.js';

describe('Wenku8Client authentication failures', () => {
  const chapter = {
    id: '1',
    index: 0,
    title: '第一章',
    sourceUrl: 'https://www.wenku8.net/novel/1/42/1.htm',
    blocks: [],
  };

  it.each([new NonRetryableHttpError('HTTP 请求无法恢复')])(
    'propagates proxy errors from packed content without trying other URLs: %s',
    async (blocked) => {
      const client = new Wenku8Client();
      const request = vi.spyOn(client.http, 'text')
        .mockResolvedValueOnce('<span>null</span>')
        .mockRejectedValue(blocked);
      await expect(client.getChapter(chapter)).rejects.toBe(blocked);
      expect(request).toHaveBeenCalledTimes(2);
    },
  );

  it('rejects structural HTTP-200 challenge pages before parsing search or chapter content', async () => {
    const client = new Wenku8Client();
    vi.spyOn(client.http, 'text').mockResolvedValue(
      '<script src="/cdn-cgi/challenge-platform/orchestrate.js"></script>',
    );
    await expect(client.search('test')).rejects.toBeInstanceOf(CloudflareChallengeError);
    await expect(client.getChapter(chapter)).rejects.toBeInstanceOf(CloudflareChallengeError);
  });

  it('does not mistake verification words inside a novel for a challenge', async () => {
    const client = new Wenku8Client();
    vi.spyOn(client.http, 'text').mockResolvedValue(
      '<div id="content">他输入了验证码，页面写着 challenge-platform 和 cf-turnstile。</div>',
    );
    const result = await client.getChapter(chapter);
    expect(
      result.chapter.blocks.some(
        (block) => block.type === 'paragraph' && block.text.includes('验证码'),
      ),
    ).toBe(true);
  });

  for (const blocked of [
    '<form><input name="username"><input name="password" type="password"></form>',
    '<script>window._cf_chl_opt = {};</script>',
  ]) {
    it('propagates authentication failure from packed content without trying other candidate URLs', async () => {
      const client = new Wenku8Client();
      const request = vi
        .spyOn(client.http, 'text')
        .mockResolvedValueOnce('<span>null</span>')
        .mockResolvedValue(blocked);
      const result = client.getChapter(chapter);
      await expect(result).rejects.toBeInstanceOf(
        blocked.startsWith('<form>') ? AuthenticationRequiredError : CloudflareChallengeError,
      );
      expect(request).toHaveBeenCalledTimes(2);
    });
  }
  it('does not interpret HTTP-200 login pages as empty search results or book content', async () => {
    const client = new Wenku8Client();
    vi.spyOn(client.http, 'text').mockResolvedValue(
      '<form><input name="username"><input name="password" type="password"></form>',
    );
    await expect(client.search('test')).rejects.toThrow(/wenku8 login/);
    await expect(client.toplist()).rejects.toThrow(/wenku8 login/);
    await expect(client.sugoi()).rejects.toThrow(/wenku8 login/);
    await expect(client.getBookDetails(1)).rejects.toThrow(/wenku8 login/);
    await expect(client.getCatalogue('https://www.wenku8.net/novel/1/index.htm')).rejects.toThrow(
      /wenku8 login/,
    );
  });
});
