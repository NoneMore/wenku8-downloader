import { describe, expect, it, vi } from 'vitest';
import { Wenku8Client } from './client.js';

describe('Wenku8Client authentication failures', () => {
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
