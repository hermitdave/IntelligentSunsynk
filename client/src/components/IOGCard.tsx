interface IOGCardProps {
  isInChargeSlot: boolean;
  useTimerLabel: string;
  schedulerRuns: number;
}

export function IOGCard({ isInChargeSlot, useTimerLabel, schedulerRuns }: IOGCardProps) {
  return (
    <div className="card">
      <h2>IOG</h2>
      <div className="status-grid" style={{ marginTop: 14 }}>
        <div className="status-item">
          <span className="label">In Charge Slot</span>
          <span className={isInChargeSlot ? 'value-yes' : 'value-no'}>
            {isInChargeSlot ? 'Yes' : 'No'}
          </span>
        </div>

        <div className="status-item">
          <span className="label">Use Timer</span>
          <span className="value">{useTimerLabel}</span>
        </div>

        <div className="status-item">
          <span className="label">Scheduler Runs</span>
          <span className="value">{schedulerRuns}</span>
        </div>
      </div>
    </div>
  );
}
