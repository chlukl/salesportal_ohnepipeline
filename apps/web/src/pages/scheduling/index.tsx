/**
 * Terminplaner als Seitenfenster (INTENT 6.6, 6.8, 6.11): Slots, Buchen, 3 Vorschläge, Zusatzcall-Schalter.
 * Used in the workspace right column (≈480px) next to the notes:
 *
 *   <SchedulingPanel leadId={id} callSessionId={callId} onClose={close} onDone={(r) => …} />
 *   <ProposalsPanel  leadId={id} callSessionId={callId} onClose={close} onDone={(r) => …} />
 *
 * Both end with the change-set preview (`ChangeSetPreview` from the changesets module) – nothing goes to the CRM
 * without approval; calendar invitations / the proposals mail are sent on the explicit click.
 */
export { ProposalsPanel } from './ProposalsPanel';
export { SchedulingPanel } from './SchedulingPanel';
export type { SchedulingPanelProps, SchedulingResult } from './types';
export { BOOKING_STATUS, bookingWhen } from './components';

import { SchedulingPanel } from './SchedulingPanel';

export default SchedulingPanel;
