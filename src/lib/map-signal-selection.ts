/** Selection affordances belong to the open signal context, never the resting map. */
export function activeSignalHighlightIds(panelOpen: boolean | undefined, selectedSignalId?: string | null, highlightedSignalId?: string | null): string[] {
  return panelOpen ? [selectedSignalId, highlightedSignalId].filter((id): id is string => Boolean(id)) : [];
}
