interface PortalDataViewProps {
  selectedDate: string;
  onDateChange: (date: string) => void;
  onRefresh: () => void;
  isLoading: boolean;
  error: string | null;
  energyFlow: Record<string, unknown> | null;
  powerGraph: Record<string, unknown> | null;
}

function formatJson(data: Record<string, unknown> | null): string {
  if (!data) {
    return 'No data loaded yet.';
  }

  return JSON.stringify(data, null, 2);
}

export function PortalDataView({
  selectedDate,
  onDateChange,
  onRefresh,
  isLoading,
  error,
  energyFlow,
  powerGraph,
}: PortalDataViewProps) {
  return (
    <div className="card">
      <div className="card-header">
        <h2>SunSynk Portal Data</h2>
        <div className="portal-controls">
          <div className="date-control">
            <label htmlFor="powerGraphDate">Power Graph Date</label>
            <input
              id="powerGraphDate"
              type="date"
              value={selectedDate}
              onChange={(event) => onDateChange(event.target.value)}
            />
          </div>
          <button className="btn-refresh" onClick={onRefresh} disabled={isLoading}>
            {isLoading ? 'Refreshing…' : '↻ Refresh Portal Data'}
          </button>
        </div>
      </div>

      {isLoading && <p className="loading-inline">Loading portal data…</p>}

      {error && (
        <div className="error-banner" role="alert">
          ⚠ {error}
        </div>
      )}

      <div className="portal-grid">
        <section>
          <h3>Energy Flow</h3>
          <pre className="json-box">{formatJson(energyFlow)}</pre>
        </section>

        <section className="portal-full-width">
          <h3>Power Graph ({selectedDate})</h3>
          <pre className="json-box">{formatJson(powerGraph)}</pre>
        </section>
      </div>
    </div>
  );
}