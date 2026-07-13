import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChargeSlots } from '../components/ChargeSlots';
import { DispatchSlot } from '../types';

// Fixed reference time used throughout all tests
const REF_TIME = new Date('2026-06-01T12:00:00Z');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(REF_TIME);
});

afterEach(() => {
  vi.useRealTimers();
});

function futureSlot(offsetMinutes: number, durationMinutes = 30): DispatchSlot {
  const start = new Date(REF_TIME.getTime() + offsetMinutes * 60_000);
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
  // started 5 min before REF_TIME, ends 25 min after REF_TIME
  const start = new Date(REF_TIME.getTime() - 5 * 60_000);
  const end = new Date(REF_TIME.getTime() + 25 * 60_000);
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
