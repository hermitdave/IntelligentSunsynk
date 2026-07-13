# IntelligentSunsynk

A **TypeScript + React** full-stack app that reads Intelligent Octopus Go EV charge slots and automatically controls a SunSynk inverter to prevent battery drain during EV grid-charging windows.

## How It Works

When Octopus schedules your EV to charge from the grid during peak hours, your home battery would normally drain to "help" power the house. This app:

1. **Fetches** upcoming Intelligent Go dispatch slots from the Octopus Energy GraphQL API.
2. **Checks** every 5 minutes (configurable) whether the current time is within an active slot.
3. **Sets** the inverter's `peakAndVallery` ("Use Timer") to `"1"` from **23:30 to 05:30**, and outside that window sets `"0"` during an active slot (to prevent battery drain) or `"1"` when no slot is active.
4. **Shows** a live dashboard with the current inverter state, all upcoming slots, and the settings snapshot.

## Architecture

```
IntelligentSunsynk/
├── server/          # Node.js + Express + TypeScript backend
│   └── src/
│       ├── index.ts                  # Entry point & startup sequence
│       ├── config.ts                 # Env-var configuration loader
│       ├── state.ts                  # In-memory application state
│       ├── services/
│       │   ├── sunsynk.ts            # SunSynk OpenAPI client (HMAC-SHA256 auth)
│       │   └── octopus.ts            # Octopus Energy GraphQL client
│       ├── jobs/
│       │   └── chargeScheduler.ts    # Cron job (peakAndVallery logic)
│       └── routes/
│           └── api.ts                # REST API served to the React frontend
└── client/          # React + TypeScript + Vite frontend
    └── src/
        ├── App.tsx                   # Main app with tab navigation
        ├── components/
        │   ├── StatusCard.tsx        # Live inverter status
        │   ├── ChargeSlots.tsx       # Dispatch slot table
        │   └── SettingsView.tsx      # Inverter settings snapshot
        └── services/api.ts           # HTTP client for the backend API
```

## Prerequisites

- Node.js 18+
- SunSynk OpenAPI credentials (api_key + api_secret) — request from SunSynk support
- SunSynk account username + password
- Inverter serial number
- Octopus Energy API key + account number (from [octopus.energy/dashboard/developer](https://octopus.energy/dashboard/developer/))
- Intelligent Octopus Go tariff

## Quick Start

```bash
git clone https://github.com/hermitdave/IntelligentSunsynk.git
cd IntelligentSunsynk

# Install all dependencies (root + server + client)
npm install

# Copy and fill in your credentials
cp .env.example .env
# edit .env
```

### Development

```bash
# Start server (port 8080, default WEB_PORT) and React dev server (port 3000) concurrently
npm start
```

Open **http://localhost:3000** for the dashboard.

### Production

```bash
npm run build            # Compiles both server and client
npm run start:server     # Serves the API + built React app at http://localhost:8080
```

## Configuration (`.env`)

| Variable | Required | Description |
|---|---|---|
| `SUNSYNK_API_KEY` | ✅ | SunSynk OpenAPI key |
| `SUNSYNK_API_SECRET` | ✅ | SunSynk OpenAPI secret (for HMAC-SHA256 signing) |
| `SUNSYNK_USERNAME` | ✅ | SunSynk account email |
| `SUNSYNK_PASSWORD` | ✅ | SunSynk account password |
| `SUNSYNK_SERIAL` | ✅ | Inverter serial number |
| `SUNSYNK_PLANT_ID` | Optional | Plant ID (auto-detected if omitted) |
| `SUNSYNK_VERIFY_SSL` | Optional | `true`/`false` (default `false`, recommended by SunSynk) |
| `OCTOPUS_API_KEY` | ✅ | Octopus Energy REST API key |
| `OCTOPUS_ACCOUNT_ID` | ✅ | Octopus account number (e.g. `A-XXXXXXXX`) |
| `OCTOPUS_OFF_PEAK_RATE` | Optional | Off-peak rate in p/kWh (default `7.0`) |
| `OCTOPUS_PEAK_RATE` | Optional | Peak rate in p/kWh (default `24.0`) |
| `BATTERY_CAPACITY_KWH` | Optional | Battery size in kWh (default `10.0`, display only) |
| `BATTERY_MIN_SOC` | Optional | Minimum SOC % (default `10`, display only) |
| `WEB_HOST` | Optional | Server bind address (default `0.0.0.0`) |
| `WEB_PORT` | Optional | Server port (default `8080`) |
| `CRON_SCHEDULE` | Optional | Cron expression (default `*/5 * * * *`) |
| `LOG_LEVEL` | Optional | `INFO` / `DEBUG` / `WARNING` (default `INFO`) |

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/status` | Full application state (auth, slots, settings, errors) |
| `GET` | `/api/charge-slots` | Current dispatch slots + active flag |
| `GET` | `/api/settings` | Saved (startup) and current inverter settings |
| `POST` | `/api/refresh` | Force an immediate scheduler run |

## Safety

- **Whitelist**: Only `peakAndVallery` (and a small set of schedule-related fields) can be written. All current/discharge limit and grid-protection settings are blocked.
- **Settings snapshot**: Inverter settings are read and saved on startup; the original values are always visible in the UI.
- **Token security**: Never commits API keys. All secrets live in `.env` which is `.gitignore`d.

## Compatibility

Tested against SunSynk 8.8 kW Hybrid inverter + Intelligent Octopus Go (UK).

> ⚠️ **USE AT YOUR OWN RISK.** Modifying inverter settings incorrectly can damage equipment. Always take a manual backup via the SunSynk Connect app before use.
