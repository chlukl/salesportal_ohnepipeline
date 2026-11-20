/** Public contract of the Terminplaner panels (used by the workspace right column). */

/** What happened in a panel – the workspace can e.g. switch to «Ergebnis & Freigabe». */
export type SchedulingResult =
  | { kind: 'booked'; bookingId: string; changeSetId: string; withCallResult: boolean }
  | { kind: 'proposals_sent'; changeSetId: string; withCallResult: boolean };

export interface SchedulingPanelProps {
  leadId: string;
  callSessionId?: string | null;
  /** Shows a close button (and closes on Esc). */
  onClose?: () => void;
  /**
   * Default true: rendered inside the workspace right column (no own frame/title, the column scrolls). false: framed
   * side panel with title.
   */
  embedded?: boolean;
  /** Called after a booking / after the proposals mail was sent (the change set waits for approval). */
  onDone?: (result: SchedulingResult) => void;
}
