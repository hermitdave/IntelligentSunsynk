import { DispatchSlot, SlotHistory, TrackedSlot } from '../types';

interface ChargeSlotsProps {
  slots: DispatchSlot[];
  isInChargeSlot: boolean;
  slotHistory?: SlotHistory;
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

function SlotRow({ slot, statusLabel, badgeClass }: { slot: TrackedSlot; statusLabel: string; badgeClass: string }) {
  return (
    <tr>
      <td><span className={badgeClass}>{statusLabel}</span></td>
      <td>{formatDateTime(slot.start)}</td>
      <td>{formatDateTime(slot.end)}</td>
      <td>{durationMinutes(slot.start, slot.end)} min</td>
      <td className="mono">{slot.source}</td>
      <td>{slot.deltaKwh !== 0 ? slot.deltaKwh.toFixed(2) : '—'}</td>
    </tr>
  );
}

function SlotSection({ title, slots, badgeClass, statusLabel }: {
  title: string;
  slots: TrackedSlot[];
  badgeClass: string;
  statusLabel: string;
}) {
  if (slots.length === 0) return null;
  return (
    <div className="slot-section">
      <h3>{title}</h3>
      <div className="table-wrapper">
        <table className="slots-table slots-table-sm">
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
            {slots.map((slot, idx) => (
              <SlotRow key={slot.fingerprint || idx} slot={slot} statusLabel={statusLabel} badgeClass={badgeClass} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function ChargeSlots({ slots, isInChargeSlot, slotHistory }: ChargeSlotsProps) {
  const sorted = [...slots].sort(
    (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime(),
  );

  const historyHasSlots = Boolean(
    slotHistory &&
      (slotHistory.active.length ||
        slotHistory.futurePlanned.length ||
        slotHistory.fulfilled.length ||
        slotHistory.yesterday.length),
  );

  return (
    <div className="card">
      <div className="card-header">
        <h2>Intelligent Go Charge Slots</h2>
        {isInChargeSlot && (
          <span className="badge-active">⚡ Active Slot Now</span>
        )}
      </div>

      {slotHistory && (
        <div className="slot-history">
          <SlotSection
            title="⚡ Currently Active"
            slots={slotHistory.active}
            badgeClass="badge-active-small"
            statusLabel="Active"
          />
          <SlotSection
            title="✅ Fulfilled Slots"
            slots={slotHistory.fulfilled}
            badgeClass="badge-fulfilled"
            statusLabel="Fulfilled"
          />
          <SlotSection
            title="📅 Yesterday's Slots"
            slots={slotHistory.yesterday}
            badgeClass="badge-past"
            statusLabel="Yesterday"
          />
          <SlotSection
            title="📆 Upcoming Planned Slots"
            slots={slotHistory.futurePlanned}
            badgeClass="badge-upcoming"
            statusLabel="Upcoming"
          />
        </div>
      )}

      {slotHistory ? (
        !historyHasSlots && (
          <p className="empty-message">No dispatch slots found from Octopus.</p>
        )
      ) : sorted.length === 0 ? (
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
