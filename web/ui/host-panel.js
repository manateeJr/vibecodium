/* global document */

export function createHostPanel({ client, elements, errorMessage, onError }) {
  let loading = false;

  const setStatus = (text) => {
    elements.hostStatus.textContent = text;
  };

  const renderStats = (stats) => {
    elements.hostStats.replaceChildren();
    const rows = [
      ['MEM', `${formatBytes(stats.mem_used)} / ${formatBytes(stats.mem_total)}`],
      ['LOAD', formatLoad(stats.load)],
      ['UPTIME', formatUptime(stats.uptime_seconds)],
      ['VIBECODIUM', `${stats.vibecodium_sessions} session(s)`],
      ['ALL HARNESSES', `${stats.global_sessions} session(s)`],
    ];
    for (const [label, value] of rows) {
      const term = document.createElement('dt');
      term.textContent = label;
      const detail = document.createElement('dd');
      detail.textContent = value;
      elements.hostStats.append(term, detail);
    }
    if (document.activeElement !== elements.hostCap)
      elements.hostCap.value = String(stats.max_concurrent);
  };

  const refresh = async () => {
    if (loading) return;
    loading = true;
    elements.hostRefresh.disabled = true;
    setStatus('loading…');
    try {
      renderStats(await client.hostStats());
      setStatus('');
    } catch (error) {
      elements.hostStats.replaceChildren();
      setStatus(`host stats unavailable: ${errorMessage(error)}`);
    } finally {
      loading = false;
      elements.hostRefresh.disabled = false;
    }
  };

  const applyCap = async () => {
    const value = Number.parseInt(elements.hostCap.value, 10);
    if (!Number.isInteger(value) || value < 1) {
      setStatus('max concurrent must be a positive integer');
      return;
    }
    elements.hostCapApply.disabled = true;
    setStatus('applying…');
    try {
      const result = await client.setSessionCap({ max_concurrent: value });
      elements.hostCap.value = String(result.max_concurrent);
      await refresh();
      setStatus(`max concurrent · ${result.max_concurrent}`);
    } catch (error) {
      const message = `session cap update failed: ${errorMessage(error)}`;
      setStatus(message);
      onError(message);
    } finally {
      elements.hostCapApply.disabled = false;
    }
  };

  elements.hostRefresh.addEventListener('click', () => void refresh());
  elements.hostCapApply.addEventListener('click', () => void applyCap());
  elements.hostCap.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    void applyCap();
  });

  return { refresh };
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MiB';
  const mib = bytes / 1024 ** 2;
  return mib >= 1024 ? `${(mib / 1024).toFixed(1)} GiB` : `${Math.round(mib)} MiB`;
}

function formatLoad(load) {
  const values = Array.isArray(load) ? load : [];
  if (values.length === 0) return 'unknown';
  return values.map((value) => Number(value).toFixed(2)).join(' · ');
}

function formatUptime(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
