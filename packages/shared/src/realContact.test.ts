import { describe, expect, it } from 'vitest';
import { CALL_STATUS, LEAD_SUPPORT, RESULT_GROUP_CODES, STATUS } from './i18n';
import {
  callListExclusions,
  computeCampaignStatus,
  isRealContactActivity,
  lastRealContact,
  type ContactActivity,
} from './realContact';
import type { CampaignMail } from './types';

const now = new Date('2026-11-20T10:00:00Z');
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();

function act(partial: Partial<ContactActivity>): ContactActivity {
  return {
    id: partial.id ?? Math.random().toString(36).slice(2),
    type: 'phonecall',
    at: daysAgo(1),
    direction: 'outgoing',
    resultCode: null,
    durationSec: null,
    text: null,
    isCampaign: false,
    statecode: 1,
    ...partial,
  };
}

describe('isRealContactActivity', () => {
  it('calls with result: reached counts, not reached / wrong number do not', () => {
    expect(isRealContactActivity(act({ resultCode: RESULT_GROUP_CODES.callback }), now)).toBe(true);
    expect(isRealContactActivity(act({ resultCode: RESULT_GROUP_CODES.has_partner }), now)).toBe(true);
    expect(isRealContactActivity(act({ resultCode: RESULT_GROUP_CODES.not_reached }), now)).toBe(false);
    expect(isRealContactActivity(act({ resultCode: RESULT_GROUP_CODES.wrong_number }), now)).toBe(false);
  });
  it('legacy calls without result: ≥ 4 min counts', () => {
    expect(isRealContactActivity(act({ durationSec: 240 }), now)).toBe(true);
    expect(isRealContactActivity(act({ durationSec: 239 }), now)).toBe(false);
    expect(isRealContactActivity(act({ durationSec: null }), now)).toBe(false);
  });
  it('notes: with text yes, portal notes and empty notes no', () => {
    expect(isRealContactActivity(act({ type: 'note', text: 'GL will Unterlagen' }), now)).toBe(true);
    expect(isRealContactActivity(act({ type: 'note', text: 'Sales-Portal: Nicht qualifiziert – zu klein' }), now)).toBe(false);
    expect(isRealContactActivity(act({ type: 'note', text: '  ' }), now)).toBe(false);
  });
  it('mails: sent personal mail yes, campaign mail / incoming no', () => {
    expect(isRealContactActivity(act({ type: 'email', direction: 'outgoing' }), now)).toBe(true);
    expect(isRealContactActivity(act({ type: 'email', direction: 'outgoing', isCampaign: true }), now)).toBe(false);
    expect(isRealContactActivity(act({ type: 'email', direction: 'incoming' }), now)).toBe(false);
  });
  it('appointments: past yes, future and cancelled no', () => {
    expect(isRealContactActivity(act({ type: 'appointment', scheduledStart: daysAgo(2) }), now)).toBe(true);
    expect(isRealContactActivity(act({ type: 'appointment', scheduledStart: daysAgo(-3) }), now)).toBe(false);
    expect(isRealContactActivity(act({ type: 'appointment', scheduledStart: daysAgo(2), statecode: 2 }), now)).toBe(false);
  });
});

describe('lastRealContact', () => {
  it('picks the newest real contact and ignores newer non-contacts', () => {
    const result = lastRealContact(
      [
        act({ id: 'a', at: daysAgo(10), resultCode: RESULT_GROUP_CODES.waiting, ownerName: 'Markus' }),
        act({ id: 'b', at: daysAgo(2), resultCode: RESULT_GROUP_CODES.not_reached }),
        act({ id: 'c', type: 'note', at: daysAgo(1), text: 'Sales-Portal: Notiz' }),
        act({ id: 'd', type: 'note', at: daysAgo(20), text: 'echte Notiz' }),
      ],
      now,
    );
    expect(result?.activityId).toBe('a');
    expect(result?.kind).toBe('call');
    expect(result?.byName).toBe('Markus');
    expect(result?.resultCode).toBe(RESULT_GROUP_CODES.waiting);
  });
  it('returns null without contacts', () => {
    expect(lastRealContact([act({ resultCode: RESULT_GROUP_CODES.not_reached })], now)).toBeNull();
  });
});

function mail(sentDaysAgo: number, reactions: CampaignMail['reactions'] = []): CampaignMail {
  return {
    id: `m${sentDaysAgo}`,
    leadId: 'l1',
    campaignName: 'KI-Kampagne Herbst',
    step: 1,
    senderName: 'Lukas',
    senderEmail: 'lukas.demo@example.ch',
    subject: 'KI im Alltag',
    sentAt: daysAgo(sentDaysAgo),
    useCaseIds: ['UC-DOC'],
    reactions,
  };
}

describe('computeCampaignStatus (3-month lock)', () => {
  it('not in campaign → not locked', () => {
    const s = computeCampaignStatus({ inCampaign: false, campaignName: null, campaignMails: [], activities: [], now });
    expect(s.locked).toBe(false);
    expect(s.fromCampaign).toBe(false);
  });
  it('mail 30 days ago → locked', () => {
    const s = computeCampaignStatus({ inCampaign: true, campaignName: 'K', campaignMails: [mail(30)], activities: [], now });
    expect(s.locked).toBe(true);
    expect(s.fromCampaign).toBe(false);
    expect(new Date(s.lockedUntil!).getTime()).toBeGreaterThan(now.getTime());
  });
  it('mail 100 days ago → unlocked, badge «aus Kampagne»', () => {
    const s = computeCampaignStatus({ inCampaign: true, campaignName: 'K', campaignMails: [mail(100)], activities: [], now });
    expect(s.locked).toBe(false);
    expect(s.fromCampaign).toBe(true);
  });
  it('opens do not extend the lock, clicks do', () => {
    const opened = computeCampaignStatus({
      inCampaign: true,
      campaignName: 'K',
      campaignMails: [mail(100, [{ kind: 'opened', at: daysAgo(10) }])],
      activities: [],
      now,
    });
    expect(opened.locked).toBe(false);
    const clicked = computeCampaignStatus({
      inCampaign: true,
      campaignName: 'K',
      campaignMails: [mail(100, [{ kind: 'clicked', at: daysAgo(10) }])],
      activities: [],
      now,
    });
    expect(clicked.locked).toBe(true);
  });
  it('a call during the lock extends it; portal notes do not', () => {
    const withCall = computeCampaignStatus({
      inCampaign: true,
      campaignName: 'K',
      campaignMails: [mail(80)],
      activities: [act({ at: daysAgo(70), resultCode: RESULT_GROUP_CODES.not_reached })],
      now,
    });
    expect(withCall.locked).toBe(true);
    expect(withCall.lastActivityAt).toBe(daysAgo(70));
    const withPortalNote = computeCampaignStatus({
      inCampaign: true,
      campaignName: 'K',
      campaignMails: [mail(120)],
      activities: [act({ type: 'note', at: daysAgo(5), text: 'Sales-Portal: x' })],
      now,
    });
    expect(withPortalNote.locked).toBe(false);
  });
  it('calls after the lock expired do not lock the lead again', () => {
    const s = computeCampaignStatus({
      inCampaign: true,
      campaignName: 'K',
      campaignMails: [mail(120)],
      activities: [act({ at: daysAgo(5), resultCode: RESULT_GROUP_CODES.not_reached })],
      now,
    });
    expect(s.locked).toBe(false);
    expect(s.fromCampaign).toBe(true);
  });
  it('positive reply is flagged', () => {
    const s = computeCampaignStatus({
      inCampaign: true,
      campaignName: 'K',
      campaignMails: [mail(20, [{ kind: 'replied_positive', at: daysAgo(19) }])],
      activities: [],
      now,
    });
    expect(s.locked).toBe(true);
    expect(s.positiveReply).toBe(true);
  });
});

describe('callListExclusions', () => {
  const base = {
    statecode: 0,
    statuscode: STATUS.NEW,
    kls_lead_support: null,
    donotphone: false,
    kls_callstatus: null,
  };
  it('open lead is visible', () => {
    expect(callListExclusions(base, { locked: false })).toEqual([]);
  });
  it('collects all reasons', () => {
    expect(callListExclusions({ ...base, kls_lead_support: LEAD_SUPPORT.DIVENDO_COLDCALL }, { locked: false })).toEqual(['divendo']);
    expect(callListExclusions({ ...base, statuscode: STATUS.SECOND_CONTACT }, { locked: false })).toEqual(['second_contact']);
    expect(callListExclusions({ ...base, statecode: 2, statuscode: 6 }, { locked: false })).toEqual(['closed']);
    expect(callListExclusions({ ...base, kls_callstatus: CALL_STATUS.DO_NOT_CONTACT }, { locked: false })).toEqual([
      'do_not_contact',
    ]);
    expect(callListExclusions(base, { locked: true })).toEqual(['campaign_locked']);
    expect(callListExclusions(base, { locked: false }, { isCustomer: true })).toEqual(['existing_account']);
  });
});
