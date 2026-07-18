import { useEffect, useState } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import { PowerGraphSeries, POWER_GRAPH_COLOURS } from '../types';

/** Use a shorter chart on phones so it fits without excessive scrolling. */
function useChartHeight(): number {
  const compute = () =>
    typeof window !== 'undefined' && window.innerWidth <= 640 ? 260 : 350;
  const [height, setHeight] = useState<number>(compute);
  useEffect(() => {
    const onResize = () => setHeight(compute());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return height;
}

interface PowerGraphChartProps {
  data: PowerGraphSeries[];
}

function buildChartData(series: PowerGraphSeries[]) {
  if (series.length === 0) return [];

  // Use the first series to determine time points
  const timePoints = series[0].records.map((r) => r.time);

  return timePoints.map((time, idx) => {
    const point: Record<string, string | number> = { time };
    for (const s of series) {
      if (s.records[idx]) {
        point[s.label] = parseFloat(s.records[idx].value) || 0;
      }
    }
    return point;
  });
}

const LABEL_COLOURS: Record<string, string> = {
  ...POWER_GRAPH_COLOURS,
  // Fallback for any labels not in the predefined set
  PV: '#f59e0b',
  Battery: '#22c55e',
  SOC: '#3b82f6',
  Load: '#ef4444',
  Grid: '#8b5cf6',
};

export function PowerGraphChart({ data }: PowerGraphChartProps) {
  const chartHeight = useChartHeight();

  if (!data || data.length === 0) {
    return <p className="chart-empty">No data available.</p>;
  }

  const chartData = buildChartData(data);

  return (
    <div className="power-graph-chart">
      <ResponsiveContainer width="100%" height={chartHeight}>
        <LineChart data={chartData} margin={{ top: 8, right: 24, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis
            dataKey="time"
            tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
            tickLine={{ stroke: 'var(--border)' }}
            interval={23}
          />
          <YAxis
            tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
            tickLine={{ stroke: 'var(--border)' }}
            width={45}
          />
          <Tooltip
            contentStyle={{
              background: 'var(--surface-2)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
              color: 'var(--text)',
            }}
            labelStyle={{ color: 'var(--text-muted)' }}
          />
          <Legend
            wrapperStyle={{ color: 'var(--text)', fontSize: 13 }}
          />
          {data.map((s) => (
            <Line
              key={s.label}
              type="monotone"
              dataKey={s.label}
              stroke={LABEL_COLOURS[s.label] ?? '#94a3b8'}
              strokeWidth={2}
              dot={false}
              connectNulls
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}