interface LoadRechargeCardProps {
  loadValue: string;
  rechargeValue: string;
}

export function LoadRechargeCard({ loadValue, rechargeValue }: LoadRechargeCardProps) {
  return (
    <div className="card">
      <h2>Electricity consumed today in kWh</h2>
      <div className="status-grid" style={{ marginTop: 14 }}>
        <div className="status-item">
          <span className="label">Load</span>
          <span className="value">{loadValue}</span>
        </div>

        <div className="status-item">
          <span className="label">Recharge</span>
          <span className="value">{rechargeValue}</span>
        </div>
      </div>
    </div>
  );
}
