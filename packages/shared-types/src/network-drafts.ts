export const NETWORK_DRAFT_HANDLE = /^[A-Za-z0-9_-]{22}$/;

export interface NetworkSavedDraftSummaryDto {
  handle: string;
  preview: string;
  createdAt: string;
  lastSavedAt: string | null;
}

export interface NetworkSavedDraftPageDto {
  entries: NetworkSavedDraftSummaryDto[];
  nextCursor: string | null;
}

export interface NetworkSavedDraftDto {
  handle: string;
  body: string;
  contentLocale: string;
  linkUrl: string | null;
}
