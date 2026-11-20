/** Client side of /api/scheduling (types mirror apps/server/src/modules/scheduling). */
import type { Booking, BookingRules, DayHalf, IsoDate, Proposal, Slot } from '@sales-portal/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/app/api';

export interface PortalPerson {
  id: string | null;
  email: string;
  displayName: string;
}

export interface ParticipantInfo {
  extraCall: boolean;
  sales: PortalPerson;
  specialist: PortalPerson;
  unavailable: PortalPerson | null;
}

export interface BookingContext {
  lead: {
    leadid: string;
    companyname: string;
    fullname: string | null;
    jobtitle: string | null;
    email: string | null;
    domain: string | null;
    origin: Booking['origin'];
    phone: string | null;
  };
  rules: BookingRules;
  participants: { standard: ParticipantInfo; extraCall: ParticipantInfo };
  subject: string;
  invitationTemplate: string;
  internalDomains: string[];
  bookings: Booking[];
  calendarMode: 'mock' | 'live';
}

export interface SlotsResponse {
  from: IsoDate;
  to: IsoDate;
  slots: Slot[];
  participants: ParticipantInfo;
  unavailableCalendars: string[];
}

export interface ProposalsResponse {
  month: IsoDate;
  proposals: Proposal[];
  text: string;
  draft: { to: string[]; subject: string; body: string };
  participants: ParticipantInfo;
  freeSlots: number;
  unavailableCalendars: string[];
}

export interface BookingResponse {
  booking: Booking;
  changeSetId: string;
  blockersPending: boolean;
  /** Booked during a call: lead fields come with the call result, this change set holds only the appointment. */
  withCallResult: boolean;
}

export interface SendProposalsResponse {
  changeSetId: string;
  sentAt: string;
  deliveredTo: string[];
  redirected: boolean;
  taskNote: string | null;
  /** Sent during a call: call status + follow-up task come with the call result, this change set holds only the mail. */
  withCallResult: boolean;
}

export const schedulingKeys = {
  context: (leadId: string) => ['scheduling', 'context', leadId] as const,
  slots: (from: IsoDate, extraCall: boolean) => ['scheduling', 'slots', from, extraCall] as const,
  months: ['scheduling', 'months'] as const,
  proposals: (leadId: string, month: IsoDate, preference: DayHalf, extraCall: boolean) => ['scheduling', 'proposals', leadId, month, preference, extraCall] as const,
};

export function useBookingContext(leadId: string) {
  return useQuery({
    queryKey: schedulingKeys.context(leadId),
    queryFn: () => api.get<BookingContext>(`/api/scheduling/context/${encodeURIComponent(leadId)}`),
    staleTime: 30_000,
  });
}

export function useWeekSlots(from: IsoDate, extraCall: boolean) {
  return useQuery({
    queryKey: schedulingKeys.slots(from, extraCall),
    queryFn: () => api.get<SlotsResponse>('/api/scheduling/slots', { from, days: 5, extraCall }),
    staleTime: 30_000,
    placeholderData: (prev) => (prev && prev.from === from ? prev : undefined),
  });
}

export function useProposalMonths() {
  return useQuery({
    queryKey: schedulingKeys.months,
    queryFn: () => api.get<{ months: IsoDate[]; preselected: IsoDate }>('/api/scheduling/proposals/months'),
    staleTime: 10 * 60_000,
  });
}
