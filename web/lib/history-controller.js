import { loadShowAllSessions, saveShowAllSessions } from './storage.js';

export function createHistoryController({
  client,
  history,
  home,
  projectManager,
  sessions,
  streamLog,
  sessionIdOf,
  errorMessage,
  renderSessions,
  loadSessions,
  actions,
}) {
  let recentLoading = false;
  let archivedLoading = false;
  let recentSessions = [];
  let archivedSessions = [];
  let showAllSessions = loadShowAllSessions();

  const loadActiveSessions = async () => {
    if (recentLoading) return;
    recentLoading = true;
    const project = projectManager.selectedProject();
    try {
      const args = { limit: 10, include_ended: true, scope: 'active' };
      if (project?.name) args.project = project.name;
      const result = await client.sessionRecent(args);
      recentSessions = [...result.sessions];
      history.renderRecent(recentSessions);
    } catch (error) {
      recentSessions = [];
      history.renderRecent([]);
      streamLog.error(`recent sessions unavailable: ${errorMessage(error)}`);
    } finally {
      recentLoading = false;
    }
  };

  const loadArchivedSessions = async () => {
    if (archivedLoading) return;
    archivedLoading = true;
    const project = projectManager.selectedProject();
    try {
      const args = { limit: 10, include_ended: true, scope: 'archived' };
      if (project?.name) args.project = project.name;
      const result = await client.sessionRecent(args);
      archivedSessions = [...result.sessions];
      history.renderArchived?.(archivedSessions);
    } catch (error) {
      archivedSessions = [];
      history.renderArchived?.([]);
      streamLog.error(`archived sessions unavailable: ${errorMessage(error)}`);
    } finally {
      archivedLoading = false;
    }
  };

  const loadRecentSessions = async () => {
    await Promise.all([loadActiveSessions(), loadArchivedSessions()]);
  };

  const setShowAllSessions = (next) => {
    showAllSessions = next;
    saveShowAllSessions(next);
    renderSessions();
    history.renderRecent(recentSessions);
    history.renderArchived?.(archivedSessions);
    void home.refresh();
  };
  const pinSession = async (item, pinned) => {
    const session_id = item?.session_id || sessionIdOf(item);
    if (!session_id) {
      streamLog.error('this session cannot be pinned');
      return;
    }
    try {
      await client.sessionPin({ session_id, pinned });
      item.pinned = pinned;
      const entry =
        sessions.get(item.stream_id || `session:${session_id}`) ||
        sessions.get(`session:${session_id}`);
      if (entry) entry.pinned = pinned;
      history.renderRecent(recentSessions);
      history.renderArchived?.(archivedSessions);
      void loadRecentSessions();
      void loadSessions();
    } catch (error) {
      streamLog.error(`session pin failed: ${errorMessage(error)}`);
    }
  };

  const sameSession = (left, right) =>
    Boolean(
      (left?.session_id && right?.session_id && left.session_id === right.session_id) ||
      (left?.stream_id && right?.stream_id && left.stream_id === right.stream_id),
    );

  const updateLocalArchive = (item, session_id, archived) => {
    item.archived = archived;
    const entry =
      sessions.get(item.stream_id || `session:${session_id}`) ||
      sessions.get(`session:${session_id}`);
    if (entry) entry.archived = archived;
    if (archived) {
      recentSessions = recentSessions.filter((candidate) => !sameSession(candidate, item));
      archivedSessions = [
        item,
        ...archivedSessions.filter((candidate) => !sameSession(candidate, item)),
      ];
    } else {
      archivedSessions = archivedSessions.filter((candidate) => !sameSession(candidate, item));
      recentSessions = [
        item,
        ...recentSessions.filter((candidate) => !sameSession(candidate, item)),
      ];
    }
    history.renderRecent(recentSessions);
    history.renderArchived?.(archivedSessions);
  };

  const archiveSession = async (item, archived) => {
    const session_id = item?.session_id || sessionIdOf(item);
    if (!session_id) {
      streamLog.error('this session cannot be archived');
      return;
    }
    try {
      if (typeof actions?.archiveSession === 'function') {
        const result = await actions.archiveSession(item, archived);
        if (result === null || result === undefined) return;
      } else {
        await client.sessionArchive({ session_id, archived });
      }
      updateLocalArchive(item, session_id, archived);
      void loadRecentSessions();
      void loadSessions();
    } catch (error) {
      streamLog.error(`session archive failed: ${errorMessage(error)}`);
    }
  };

  return {
    get showAllSessions() {
      return showAllSessions;
    },
    loadRecentSessions,
    loadArchivedSessions,
    pinSession,
    archiveSession,
    setShowAllSessions,
  };
}
