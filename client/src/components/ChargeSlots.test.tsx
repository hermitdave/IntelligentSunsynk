import { render, screen } from '@testing-library/react';
import { ChargeSlots } from '../components/ChargeSlots';
import { DispatchSlot } from '../types';

function futureSlot(offsetMinutes: number, durationMinutes = 30): DispatchSlot {
  const start = new Date(Date.now() + offsetMinutes * 60_000);
  const end = new Date(start.getTime() + durationMinutes * 60_000);
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    source: 'smart-charge',
    deltaKwh: -10,
    location: 'home',
  };
}

function activeSlot(): DispatchSlot {
  const start = new Date(Date.now() - 5 * 60_000);  // started 5 min ago
  const end = new Date(Date.now() + 25 * 60_000);   // ends in 25 min
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    source: 'bump-charge',
    deltaKwh: -5,
    location: null,
  };
}

describe('ChargeSlots', () => {
  it('renders empty state when no slots', () => {
    render(<ChargeSlots slots={[]} isInChargeSlot={false} />);
    expect(screen.getByText(/no upcoming dispatch slots/i)).toBeInTheDocument();
  });

  it('renders upcoming slots', () => {
    const slots = [futureSlot(60), futureSlot(180)];
    render(<ChargeSlots slots={slots} isInChargeSlot={false} />);
    const upcoming = screen.getAllByText('Upcoming');
    expect(upcoming.length).toBe(2);
  });

  it('marks an active slot as Active', () => {
    render(<ChargeSlots slots={[activeSlot()]} isInChargeSlot={true} />);
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText(/active slot now/i)).toBeInTheDocument();
  });

  it('shows duration in minutes', () => {
    render(<ChargeSlots slots={[futureSlot(60, 30)]} isInChargeSlot={false} />);
    expect(screen.getByText('30 min')).toBeInTheDocument();
  });
});
