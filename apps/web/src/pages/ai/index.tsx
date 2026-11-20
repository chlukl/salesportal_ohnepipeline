/**
 * KI-Bausteine (INTENT 6.4, 6.7, 6.10): «Analysen zur Freigabe», Use-Case-Mail, Briefing.
 * Used by the workspace (Use-Case-Mail, Briefing) and the Pendenzen (Analysen, Briefings). Names/props are the contract.
 */
export { AnalysisReviewList, REVIEW_QUERY_KEY, type AnalysisReviewListProps } from './AnalysisReviewList';
export { BriefingView, type BriefingViewProps } from './BriefingView';
export { UseCaseMailPanel, type UseCaseMailPanelProps } from './UseCaseMailPanel';
export type { AnalysisReviewItem, BriefingViewResponse, DraftMailResponse, SendMailResponse } from './types';

import { AnalysisReviewList } from './AnalysisReviewList';
export default AnalysisReviewList;
