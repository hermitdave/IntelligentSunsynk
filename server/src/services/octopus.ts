/**
 * Octopus Energy API client.
 *
 * Fetches Intelligent Go planned dispatch slots via the Octopus GraphQL API.
 *
 * Flow:
 *  1. Obtain a Kraken token by exchanging the REST API key via GraphQL mutation.
 *  2. Query plannedDispatches(accountNumber) to get upcoming cheap-rate slots.
 *
 * Reference: https://github.com/hermitdave/SunSynk-Octopus
 */
import axios from 'axios';
import { Config } from '../config';
import { DispatchSlot } from '../types';

const OCTOPUS_GRAPHQL_URL = 'https://api.octopus.energy/v1/graphql/';

/** Kraken token is cached for 30 minutes (tokens are valid ~1 hour). */
const TOKEN_TTL_MS = 30 * 60 * 1000;

interface KrakenTokenResponse {
  data?: {
    obtainKrakenToken?: {
      token: string;
    };
  };
  errors?: Array<{ message: string }>;
}

interface PlannedDispatchResponse {
  data?: {
    plannedDispatches?: Array<{
      startDt: string;
      endDt: string;
      delta: number | null;
      meta?: {
        source?: string;
        location?: string;
      };
    }>;
  };
  errors?: Array<{ message: string }>;
}

export class OctopusService {
  private config: Config;
  private krakenToken: string | null = null;
  private tokenObtainedAt: number | null = null;

  constructor(config: Config) {
    this.config = config;
  }

  // ===========================================================================
  // Kraken token management
  // ===========================================================================

  /**
   * Obtain (or return cached) Kraken GraphQL token.
   * Exchanges the REST API key for a short-lived Kraken JWT.
   */
  private async getKrakenToken(): Promise<string> {
    // Return cached token if still fresh
    if (this.krakenToken && this.tokenObtainedAt) {
      if (Date.now() - this.tokenObtainedAt < TOKEN_TTL_MS) {
        return this.krakenToken;
      }
    }

    const mutation = `
      mutation obtainKrakenToken($apiKey: String!) {
        obtainKrakenToken(input: { APIKey: $apiKey }) {
          token
        }
      }
    `;

    const response = await axios.post<KrakenTokenResponse>(
      OCTOPUS_GRAPHQL_URL,
      {
        query: mutation,
        variables: { apiKey: this.config.octopusApiKey },
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 30_000,
      },
    );

    if (response.data.errors?.length) {
      throw new Error(
        'Octopus Kraken token error: ' + response.data.errors.map((e) => e.message).join(', '),
      );
    }

    const token = response.data?.data?.obtainKrakenToken?.token;
    if (!token) {
      throw new Error('Octopus returned no Kraken token');
    }

    this.krakenToken = token;
    this.tokenObtainedAt = Date.now();
    return token;
  }

  // ===========================================================================
  // Dispatch slots
  // ===========================================================================

  /**
   * Fetch Intelligent Go planned dispatch slots for the configured account.
   *
   * Returns all upcoming slots where Octopus schedules cheap-rate EV charging.
   * The inverter should switch to charging mode during these windows to avoid
   * draining the home battery while the EV charges from the grid.
   */
  async getDispatchSlots(): Promise<DispatchSlot[]> {
    if (!this.config.octopusAccountId) {
      throw new Error('OCTOPUS_ACCOUNT_ID is not configured');
    }

    const token = await this.getKrakenToken();

    const query = `
      query getDispatches($accountNumber: String!) {
        plannedDispatches(accountNumber: $accountNumber) {
          startDt
          endDt
          delta
          meta {
            source
            location
          }
        }
      }
    `;

    const response = await axios.post<PlannedDispatchResponse>(
      OCTOPUS_GRAPHQL_URL,
      {
        query,
        variables: { accountNumber: this.config.octopusAccountId },
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: token,
        },
        timeout: 30_000,
      },
    );

    if (response.data.errors?.length) {
      throw new Error(
        'Octopus dispatch query error: ' + response.data.errors.map((e) => e.message).join(', '),
      );
    }

    const planned = response.data?.data?.plannedDispatches ?? [];

    return planned.map((slot): DispatchSlot => {
      // Octopus returns format "2026-01-02 20:30:00+00:00" – normalise to ISO 8601
      const startIso = slot.startDt.replace(' ', 'T');
      const endIso = slot.endDt.replace(' ', 'T');

      return {
        start: startIso,
        end: endIso,
        source: slot.meta?.source ?? 'smart-charge',
        deltaKwh: typeof slot.delta === 'number' ? slot.delta : 0,
        location: slot.meta?.location ?? null,
      };
    });
  }
}
