import { describe, expect, it } from 'vitest';
import { buildChangeSetBody, parseBatchResponse } from '../src/integrations/live/dataverse';
import {
  domainOf,
  fieldPayload,
  htmlToText,
  leadCreatePayload,
  mapLeadRecord,
  parseMultiSelect,
  phoneMatches,
  phoneSuffixes,
  phoneVariants,
  sameValue,
  textToHtml,
} from '../src/integrations/live/dataverseMapping';
import { assertGuid, buildQuery, entityPath, escapeLike, f, literal, quote } from '../src/integrations/live/odata';
import { buildLeadFilter } from '../src/integrations/crm/live';

const G = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

describe('OData query building and escaping', () => {
  it('doubles single quotes in string literals (no injection)', () => {
    expect(quote("O'Brien")).toBe("'O''Brien'");
    expect(f.eq('companyname', "x' or 1 eq 1 or name eq '")).toBe("companyname eq 'x'' or 1 eq 1 or name eq '''");
  });

  it('escapes LIKE wildcards in contains/startswith', () => {
    expect(escapeLike('50%_[x]')).toBe('50[%][_][[]x]');
    expect(f.contains('companyname', "100% M'tal")).toBe("contains(companyname,'100[%] M''tal')");
    expect(f.startswith('address1_postalcode', '40')).toBe("startswith(address1_postalcode,'40')");
  });

  it('validates GUIDs and field names', () => {
    expect(assertGuid(G.toUpperCase())).toBe(G);
    expect(() => assertGuid("x') or (1 eq 1")).toThrow();
    expect(() => entityPath('leads', 'not-a-guid')).toThrow();
    expect(() => f.eq('name eq 1 or x', 1)).toThrow();
    expect(() => buildQuery({ select: ['leadid', 'x)'] })).toThrow();
    expect(entityPath('leads', G)).toBe(`leads(${G})`);
  });

  it('formats literals', () => {
    expect(literal(null)).toBe('null');
    expect(literal(true)).toBe('true');
    expect(literal(42)).toBe('42');
    expect(literal(new Date('2026-11-20T09:00:00Z'))).toBe('2026-11-20T09:00:00.000Z');
    expect(literal({ guid: G })).toBe(G);
    expect(() => literal({ guid: 'x' })).toThrow();
    expect(() => literal(Number.NaN)).toThrow();
  });

  it('folds and/or with neutral elements and builds In() for many ids', () => {
    expect(f.and(null, f.eq('statecode', 0))).toBe('statecode eq 0');
    expect(f.and(f.eq('a', 1), f.eq('b', 2))).toBe('(a eq 1) and (b eq 2)');
    expect(f.and(f.eq('a', 1), f.anyOf('b', []))).toBe('false');
    expect(f.or(f.eq('a', 1), 'true')).toBe('true');
    expect(f.inGuids('regardingobjectid', [G])).toBe(`Microsoft.Dynamics.CRM.In(PropertyName='regardingobjectid',PropertyValues=['${G}'])`);
    expect(f.inGuids('regardingobjectid', [])).toBe('false');
    expect(() => f.inGuids('regardingobjectid', ["x'"])).toThrow();
  });

  it('builds a percent-encoded query string', () => {
    const q = buildQuery({
      select: ['leadid', 'companyname'],
      filter: f.and(f.eq('statecode', 0), f.contains('companyname', 'A&B')),
      orderby: [{ field: 'modifiedon', dir: 'desc' }],
      top: 10,
    });
    expect(q.startsWith('?$select=leadid,companyname&$filter=')).toBe(true);
    expect(q).toContain(encodeURIComponent("contains(companyname,'A&B')"));
    expect(q).toContain('$orderby=modifiedon%20desc');
    expect(q).toContain('$top=10');
    expect(q).not.toContain('&B');
  });
});

describe('lead filter push-down', () => {
  it('pushes visibility, score, grade, owners and PLZ to Dataverse', () => {
    const filter = buildLeadFilter({ grades: ['A', 'unrated'], ownerIds: [G, 'bogus'], plzPrefixes: ['40'], requirePhone: true, scoreMin: 10 });
    expect(filter).toContain('statecode eq 0');
    expect(filter).toContain('donotphone eq false');
    expect(filter).toContain('kls_leadscore ge 70');
    expect(filter).toContain('kls_leadscore eq null');
    expect(filter).toContain(`PropertyName='ownerid'`);
    expect(filter).not.toContain('bogus');
    expect(filter).toContain("startswith(address1_postalcode,'40')");
    expect(filter).toContain('telephone1 ne null');
  });

  it('includeHidden drops the visibility filter; digit searches stay in memory', () => {
    expect(buildLeadFilter({ includeHidden: true })).toBe('true');
    expect(buildLeadFilter({ includeHidden: true, search: '061 123 45' })).toBe('true');
    expect(buildLeadFilter({ includeHidden: true, search: "Müller's" })).toContain("contains(companyname,'Müller''s')");
  });
});

describe('Dataverse mapping', () => {
  it('maps a lead row with formatted values, lookups and multi-select', () => {
    const rec = mapLeadRecord({
      leadid: G.toUpperCase(),
      companyname: 'Muster AG',
      firstname: 'Anna',
      lastname: 'Muster',
      websiteurl: 'www.muster.ch',
      kls_industry: 845140003,
      'kls_industry@OData.Community.Display.V1.FormattedValue': 'Maschinenbau',
      kls_interests: '845140000,845140014',
      _ownerid_value: '44444444-4444-4444-8444-444444444444',
      '_ownerid_value@OData.Community.Display.V1.FormattedValue': 'Markus',
      statecode: 0,
      statuscode: 1,
      donotphone: false,
      createdon: '2026-01-01T00:00:00Z',
      modifiedon: '2026-11-01T00:00:00Z',
    });
    expect(rec.leadid).toBe(G);
    expect(rec.kls_industry).toBe('Maschinenbau');
    expect(rec.kls_interests).toEqual([845140000, 845140014]);
    expect(rec.ownerid).toBe('44444444-4444-4444-8444-444444444444');
    expect(rec.ownerName).toBe('Markus');
    expect(rec.fullname).toBe('Anna Muster');
    expect(rec.domain).toBe('muster.ch');
  });

  it('derives the domain, ignoring freemail', () => {
    expect(domainOf(null, 'a@firma.ch')).toBe('firma.ch');
    expect(domainOf(null, 'a@gmail.com')).toBeNull();
    expect(domainOf('https://www.firma.ch/kontakt', null)).toBe('firma.ch');
  });

  it('writes lookups as @odata.bind and multi-select as comma list', () => {
    expect(fieldPayload('ownerid', G)).toEqual({ 'ownerid@odata.bind': `/systemusers(${G})` });
    expect(fieldPayload('ownerid', null)).toEqual({ ownerid: null });
    expect(fieldPayload('kls_interests', [845140014, 845140000, 845140014])).toEqual({ kls_interests: '845140014,845140000' });
    expect(() => fieldPayload('ownerid', 'x')).toThrow();
    expect(() => fieldPayload('kls_industry', 'Maschinenbau')).toThrow();
    expect(parseMultiSelect('1, 2')).toEqual([1, 2]);
  });

  it('new lead payload skips computed/read-only fields', () => {
    const body = leadCreatePayload({ companyname: 'Neu AG', leadid: G, fullname: 'x', ownerid: G, kls_interests: [1] });
    expect(body).toEqual({ companyname: 'Neu AG', 'ownerid@odata.bind': `/systemusers(${G})`, kls_interests: '1' });
  });

  it('compares values for conflict detection', () => {
    expect(sameValue(null, '')).toBe(true);
    expect(sameValue([1, 2], '2,1')).toBe(true);
    expect(sameValue('2026-11-20T09:00:00Z', '2026-11-20T09:00:00.000Z')).toBe(true);
    expect(sameValue(845140001, '845140001')).toBe(true);
    expect(sameValue(845140001, 845140002)).toBe(false);
    expect(sameValue(G.toUpperCase(), G)).toBe(true);
  });

  it('converts text ↔ HTML safely', () => {
    expect(textToHtml('<b>Hallo</b>\nWelt')).toBe('<div>&lt;b&gt;Hallo&lt;/b&gt;<br>Welt</div>');
    expect(htmlToText('<p>Hallo&nbsp;<b>Welt</b></p><script>alert(1)</script>')).toBe('Hallo Welt');
  });
});

describe('phone search variants', () => {
  it('produces the usual CRM spellings of a Swiss number', () => {
    const v = phoneVariants('+41611234567');
    expect(v).toEqual(expect.arrayContaining(['+41611234567', '+41 61 123 45 67', '061 123 45 67', '0611234567', '0041611234567', '0041 61 123 45 67']));
    expect(phoneSuffixes('611234567')).toEqual(['4567', '45 67']);
    expect(phoneSuffixes('12')).toEqual([]);
  });

  it('matches CRM values in any format, incl. «mehrere Nummern» fields', () => {
    expect(phoneMatches('061 123 45 67', '+41611234567', '')).toBe(true);
    expect(phoneMatches('+41 (0)61 123 45 67 / 079 123 45 67', '+41791234567', '')).toBe(true);
    expect(phoneMatches('061 123 45 68', '+41611234567', '')).toBe(false);
    expect(phoneMatches('061 123 45 67', null, '1234567')).toBe(true);
  });
});

describe('$batch change set', () => {
  it('builds a multipart body with If-Match per operation', () => {
    const body = buildChangeSetBody('https://org.crm4.dynamics.com/api/data/v9.2/', 'batch_1', 'changeset_1', [
      { method: 'PATCH', path: `leads(${G})`, body: { kls_callstatus: 845140001 }, etag: 'W/"123"' },
      { method: 'POST', path: 'annotations', body: { notetext: 'x' } },
    ]);
    expect(body).toContain('Content-Type: multipart/mixed; boundary=changeset_1');
    expect(body).toContain(`PATCH https://org.crm4.dynamics.com/api/data/v9.2/leads(${G}) HTTP/1.1`);
    expect(body).toContain('If-Match: W/"123"');
    expect(body).toContain('Content-ID: 2');
    expect(body.trim().endsWith('--batch_1--')).toBe(true);
  });

  it('parses per-operation results incl. created ids and errors', () => {
    const text = [
      '--batchresponse_1',
      'Content-Type: multipart/mixed; boundary=changesetresponse_1',
      '',
      '--changesetresponse_1',
      'Content-Type: application/http',
      'Content-Transfer-Encoding: binary',
      'Content-ID: 1',
      '',
      'HTTP/1.1 204 No Content',
      'OData-Version: 4.0',
      `OData-EntityId: https://org.crm4.dynamics.com/api/data/v9.2/annotations(${G})`,
      '',
      '',
      '--changesetresponse_1',
      'Content-Type: application/http',
      'Content-ID: 2',
      '',
      'HTTP/1.1 412 Precondition Failed',
      'Content-Type: application/json',
      '',
      '{"error":{"code":"0x80060882","message":"The version of the existing record doesn\'t match"}}',
      '--changesetresponse_1--',
      '--batchresponse_1--',
    ].join('\r\n');
    const parts = parseBatchResponse(text);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({ status: 204, contentId: 1 });
    expect(parts[0].headers['odata-entityid']).toContain(G);
    expect(parts[1]).toMatchObject({ status: 412, contentId: 2, errorCode: '0x80060882' });
  });
});
