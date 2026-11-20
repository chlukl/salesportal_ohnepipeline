import { describe, expect, it } from 'vitest';
import { UpstreamHttpError } from '../src/integrations/live/errors';
import { HttpClient, parseRetryAfter, safePath } from '../src/integrations/live/http';
import { fakeFetch } from './live-helpers';

function client(routes: Parameters<typeof fakeFetch>[0], sleeps: number[] = []) {
  const ff = fakeFetch(routes);
  const http = new HttpClient({ fetch: ff.fetch, sleep: async (ms) => void sleeps.push(ms), random: () => 0, baseDelayMs: 100, now: () => Date.parse('2026-11-20T09:00:00Z') });
  return { http, calls: ff.calls, sleeps };
}

describe('live http client – retries', () => {
  it('retries 429 honouring Retry-After (seconds)', async () => {
    let n = 0;
    const { http, calls, sleeps } = client([() => (++n < 3 ? { status: 429, headers: { 'Retry-After': '2' }, body: {} } : { body: { ok: true } })]);
    const res = await http.send({ service: 'dataverse', method: 'GET', url: 'https://x.test/api/leads?$filter=secret' });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([2000, 2000]);
  });

  it('honours Retry-After as HTTP date and caps the wait', () => {
    expect(parseRetryAfter('Fri, 20 Nov 2026 09:00:05 GMT', Date.parse('2026-11-20T09:00:00Z'))).toBe(5000);
    expect(parseRetryAfter('1.5', 0)).toBe(1500);
    expect(parseRetryAfter('garbage', 0)).toBeNull();
  });

  it('uses exponential backoff without Retry-After on 503 for idempotent requests', async () => {
    let n = 0;
    const { http, sleeps } = client([() => (++n <= 2 ? { status: 503, body: {} } : { body: {} })]);
    const res = await http.send({ service: 'graph', method: 'GET', url: 'https://x.test/a' });
    expect(res.status).toBe(200);
    expect(sleeps).toEqual([100, 200]);
  });

  it('does not retry 503 for non-idempotent POSTs (throttle_only), but does retry 429', async () => {
    const { http, calls } = client([() => ({ status: 503, body: {} })]);
    const res = await http.send({ service: 'graph', method: 'POST', url: 'https://x.test/sendMail', body: '{}' });
    expect(res.status).toBe(503);
    expect(calls).toHaveLength(1);

    let n = 0;
    const second = client([() => (++n === 1 ? { status: 429, body: {} } : { status: 202, text: '' })]);
    const ok = await second.http.send({ service: 'graph', method: 'POST', url: 'https://x.test/sendMail', body: '{}' });
    expect(ok.status).toBe(202);
    expect(second.calls).toHaveLength(2);
  });

  it('gives up after maxRetries and returns the last response', async () => {
    const { http, calls } = client([() => ({ status: 429, body: {} })]);
    const res = await http.send({ service: 'dataverse', method: 'GET', url: 'https://x.test/a' });
    expect(res.status).toBe(429);
    expect(calls).toHaveLength(5);
  });

  it('retries network errors for idempotent requests and then throws a safe upstream error', async () => {
    let n = 0;
    const http = new HttpClient({
      fetch: async () => {
        n++;
        throw new TypeError('fetch failed');
      },
      sleep: async () => {},
      maxRetries: 2,
    });
    await expect(http.send({ service: 'dataverse', method: 'GET', url: 'https://x.test/a' })).rejects.toBeInstanceOf(UpstreamHttpError);
    expect(n).toBe(3);
  });

  it('logs paths without query strings, ids or mailboxes', () => {
    expect(safePath('https://org.crm4.dynamics.com/api/data/v9.2/leads(aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee)?$filter=telephone1')).toBe(
      'org.crm4.dynamics.com/api/data/v9.2/leads(:id)',
    );
    expect(safePath('https://graph.microsoft.com/v1.0/users/markus%40kallysoft.ch/events')).toBe('graph.microsoft.com/v1.0/users/:mailbox/events');
  });
});
