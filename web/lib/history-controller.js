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
}) {
  let recentLoading = false;
  let recentSessions = [];
  let showAllSessions = loadShowAllSessions();

  const loadRecentSessions = async () => {
    if (recentLoading) return;
    recentLoading = true;
    const project = projectManager.selectedProject();
    try {
      const args = { limit: 10, include_ended: true };
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

  const setShowAllSessions = (next) => {
    showAllSessions = next;
    saveShowAllSessions(next);
    renderSessions();
    history.renderRecent(recentSessions);
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
      const entry = sessions.get(item.stream_id || `session:${session_id}`);
      if (entry) entry.pinned = pinned;
      void loadRecentSessions();
      void loadSessions();
    } catch (error) {
      streamLog.error(`session pin failed: ${errorMessage(error)}`);
    }
  };

  return {
    get showAllSessions() {
      return showAllSessions;
    },
    loadRecentSessions,
    pinSession,
    setShowAllSessions,
  };
}
