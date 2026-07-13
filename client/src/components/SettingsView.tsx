
interface SettingsProps {
  saved: Record<string, string> | null;
  current: Record<string, string> | null;
}

const KEY_DISPLAY_NAMES: Record<string, string> = {
  peakAndVallery: 'Use Timer',
  sysWorkMode: 'System Work Mode',
  sdChargeOn: 'Grid Charge (sdChargeOn)',
  sellTime1: 'Slot 1 End Time',
  sellTime2: 'Slot 2 End Time',
  sellTime3: 'Slot 3 End Time',
  sellTime4: 'Slot 4 End Time',
  sellTime5: 'Slot 5 End Time',
  sellTime6: 'Slot 6 End Time',
  time1on: 'Slot 1 Enabled',
  time2on: 'Slot 2 Enabled',
  time3on: 'Slot 3 Enabled',
  time4on: 'Slot 4 Enabled',
  time5on: 'Slot 5 Enabled',
  time6on: 'Slot 6 Enabled',
  cap1: 'Slot 1 Target SOC',
  cap2: 'Slot 2 Target SOC',
  cap3: 'Slot 3 Target SOC',
  cap4: 'Slot 4 Target SOC',
  cap5: 'Slot 5 Target SOC',
  cap6: 'Slot 6 Target SOC',
};

// Keys to show in the compact settings summary (most relevant to this app)
const DISPLAY_KEYS = [
  'peakAndVallery', 'sysWorkMode', 'sdChargeOn',
  'sellTime1', 'sellTime2', 'sellTime3', 'sellTime4', 'sellTime5', 'sellTime6',
  'time1on', 'time2on', 'time3on', 'time4on', 'time5on', 'time6on',
  'cap1', 'cap2', 'cap3', 'cap4', 'cap5', 'cap6',
];

export function SettingsView({ saved, current }: SettingsProps) {
  if (!saved && !current) {
    return (
      <div className="card">
        <h2>Inverter Settings</h2>
        <p className="empty-message">No settings loaded yet.</p>
      </div>
    );
  }

  return (
    <div className="card">
      <h2>Inverter Settings Snapshot</h2>
      <p className="settings-note">
        <strong>Saved</strong> = settings read on startup (original state).{' '}
        <strong>Current</strong> = settings last read from the inverter.
      </p>

      <div className="table-wrapper">
        <table className="settings-table">
          <thead>
            <tr>
              <th>Setting</th>
              <th>Saved</th>
              <th>Current</th>
              <th>Changed?</th>
            </tr>
          </thead>
          <tbody>
            {DISPLAY_KEYS.filter((k) => (saved && k in saved) || (current && k in current)).map(
              (key) => {
                const savedVal = saved?.[key] ?? '—';
                const currentVal = current?.[key] ?? '—';
                const changed = savedVal !== currentVal && savedVal !== '—' && currentVal !== '—';
                return (
                  <tr key={key} className={changed ? 'row-changed' : ''}>
                    <td className="setting-key">{KEY_DISPLAY_NAMES[key] ?? key}</td>
                    <td className="mono">{savedVal}</td>
                    <td className="mono">{currentVal}</td>
                    <td>{changed ? <span className="badge-changed">Changed</span> : ''}</td>
                  </tr>
                );
              },
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
