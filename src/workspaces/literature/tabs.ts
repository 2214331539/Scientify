export type LiteratureTab = { id: string; paperId: string | null };
export type LiteratureSession = { tabs: LiteratureTab[]; activeId: string | null };

export function openPaperTab(session: LiteratureSession, paperId: string): LiteratureSession {
  const existing = session.tabs.find((tab) => tab.paperId === paperId);
  if (existing)
    return session.activeId === existing.id ? session : { ...session, activeId: existing.id };
  const blank = session.tabs.find((tab) => tab.id === session.activeId && tab.paperId === null);
  if (blank)
    return {
      tabs: session.tabs.map((tab) => (tab.id === blank.id ? { ...tab, paperId } : tab)),
      activeId: blank.id,
    };
  let id = `paper:${paperId}`;
  let suffix = 1;
  while (session.tabs.some((tab) => tab.id === id)) id = `paper:${paperId}:${suffix++}`;
  const tab = { id, paperId };
  return { tabs: [...session.tabs, tab], activeId: tab.id };
}

export function closePaperTab(session: LiteratureSession, id: string): LiteratureSession {
  const index = session.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return session;
  const tabs = session.tabs.filter((tab) => tab.id !== id);
  return {
    tabs,
    activeId:
      session.activeId === id
        ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? null)
        : session.activeId,
  };
}

/** UI preferences may be stale or malformed; never restore another project's paper. */
export function restorePaperTabs(
  value: LiteratureSession | undefined,
  paperIds: Set<string>,
  selectedPaper: string | null,
): LiteratureSession {
  const ids = new Set<string>(),
    papers = new Set<string>();
  const tabs: LiteratureTab[] = [];
  if (Array.isArray(value?.tabs))
    for (const tab of value.tabs) {
      if (!tab || typeof tab.id !== 'string' || !tab.id || ids.has(tab.id)) continue;
      if (
        tab.paperId !== null &&
        (typeof tab.paperId !== 'string' || !paperIds.has(tab.paperId) || papers.has(tab.paperId))
      )
        continue;
      ids.add(tab.id);
      if (tab.paperId) papers.add(tab.paperId);
      tabs.push({ id: tab.id, paperId: tab.paperId });
    }
  const session = {
    tabs,
    activeId: tabs.find((tab) => tab.id === value?.activeId)?.id ?? tabs.at(-1)?.id ?? null,
  };
  return selectedPaper && paperIds.has(selectedPaper)
    ? openPaperTab(session, selectedPaper)
    : session;
}
