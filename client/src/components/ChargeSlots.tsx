import { DispatchSlot } from '../types';

interface ChargeSlotsProps {
  slots: DispatchSlot[];
  isInChargeSlot: boolean;
}

function formatDateTime(isoString: string): string {
  return new Date(isoString).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function durationMinutes(start: string, end: string): number {
  return Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60_000);
}

function isSlotActive(slot: DispatchSlot): boolean {
  const now = Date.now();
  return now >= new Date(slot.start).getTime() && now < new Date(slot.end).getTime();
}

function isSlotPast(slot: DispatchSlot): boolean {
  return Date.now() >= new Date(slot.end).getTime();
}

export function ChargeSlots({ slots, isInChargeSlot }: ChargeSlotsProps) {
  const sorted = [...slots].sort(
    (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime(),
  );

  return (
    <div className="card">
      <div className="card-header">
        <h2>Intelligent Go Charge Slots</h2>
        {isInChargeSlot && (
          <span className="badge-active">⚡ Active Slot Now</span>
        )}
      </div>

      {sorted.length === 0 ? (
        <p className="empty-message">No upcoming dispatch slots found from Octopus.</p>
      ) : (
        <div className="table-wrapper">
          <table className="slots-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Start</th>
                <th>End</th>
                <th>Duration</th>
                <th>Source</th>
                <th>Energy (kWh)</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((slot, idx) => {
                const active = isSlotActive(slot);
                const past = isSlotPast(slot);
                return (
                  <tr
                    key={idx}
                    className={active ? 'row-active' : past ? 'row-past' : 'row-upcoming'}
                  >
                    <td>
                      {active ? (
                        <span className="badge-active-small">Active</span>
                      ) : past ? (
                        <span className="badge-past">Past</span>
                      ) : (
                        <span className="badge-upcoming">Upcoming</span>
                      )}
                    </td>
                    <td>{formatDateTime(slot.start)}</td>
                    <td>{formatDateTime(slot.end)}</td>
                    <td>{durationMinutes(slot.start, slot.end)} min</td>
                    <td className="mono">{slot.source}</td>
                    <td>{slot.deltaKwh !== 0 ? slot.deltaKwh.toFixed(2) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
