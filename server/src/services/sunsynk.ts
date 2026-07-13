/**
 * SunSynk Cloud API service.
 *
 * Authentication: POST https://openapi.sunsynk.net/oauth/token
 *   Uses HMAC-SHA256 signed request with api_key + api_secret.
 *
 * Data / Control: https://api.sunsynk.net
 *   All endpoints use a bearer token obtained during auth.
 *
 * Reference: https://github.com/hermitdave/SunSynk-Octopus
 */
import axios, { AxiosInstance } from 'axios';
import * as crypto from 'crypto';
import { Config } from '../config';
import { InverterSettings, SunsynkPlant, SunsynkInverter, SunsynkToken } from '../types';

const OPENAPI_AUTH_URL = 'https://openapi.sunsynk.net';
const API_DATA_URL = 'https://api.sunsynk.net';

/**
 * Subset of settings this app is allowed to write.
 * Mirrors the ALLOWED_SETTINGS whitelist from the reference project.
 */
const ALLOWED_WRITE_SETTINGS = new Set([
  'peakAndVallery',
  'sysWorkMode',
  'sdChargeOn',
  'time1on', 'time2on', 'time3on', 'time4on', 'time5on', 'time6on',
  'time1On', 'time2On', 'time3On', 'time4On', 'time5On', 'time6On',
  'sellTime1', 'sellTime2', 'sellTime3', 'sellTime4', 'sellTime5', 'sellTime6',
  'sellTime1Pac', 'sellTime2Pac', 'sellTime3Pac', 'sellTime4Pac', 'sellTime5Pac', 'sellTime6Pac',
  'cap1', 'cap2', 'cap3', 'cap4', 'cap5', 'cap6',
]);

export class SunsynkService {
  private config: Config;
  private client: AxiosInstance;
  private accessToken: string | null = null;
  private tokenExpiresAt: Date | null = null;

  constructor(config: Config) {
    this.config = config;
    this.client = axios.create({
      baseURL: API_DATA_URL,
      timeout: 30_000,
    });
  }

  // ===========================================================================
  // Authentication
  // ===========================================================================

  /**
   * Compute the standard HTTP Content-MD5 header value for a request body.
   *
   * This is NOT a password hash — it is a request-body integrity checksum
   * required by the SunSynk OpenAPI signature scheme (per their documentation).
   * The security of the authentication comes from the HMAC-SHA256 signature
   * computed in `calcSignature`, not from this checksum.
   */
  private calcMd5(data: string): string {
    if (!data) return '';
    return crypto.createHash('md5').update(data, 'utf8').digest('base64');
  }

  /** Build the HMAC-SHA256 signed request headers for OpenAPI auth. */
  private calcSignature(
    method: string,
    accept: string,
    md5: string,
    contentType: string,
    path: string,
  ): { signature: string; nonce: string } {
    const nonce = crypto.randomUUID();

    // Signature format per SunSynk documentation:
    // METHOD\nAccept\nContent-MD5\nContent-Type\n\nx-ca-key:KEY\nx-ca-nonce:NONCE\nPATH
    const lines = [
      method.toUpperCase(),
      accept,
      md5,
      contentType,
      '',
      'x-ca-key:' + this.config.sunsynkApiKey,
      'x-ca-nonce:' + nonce,
      path,
    ];
    const textToSign = lines.join('\n');

    const signature = crypto
      .createHmac('sha256', this.config.sunsynkApiSecret)
      .update(textToSign, 'utf8')
      .digest('base64');

    return { signature, nonce };
  }

  /**
   * Obtain an access token from openapi.sunsynk.net using OpenAPI credentials.
   * Token is cached and refreshed before expiry (7-day lifetime, refresh at 6 days).
   */
  async authenticate(): Promise<void> {
    if (this.accessToken && this.tokenExpiresAt && new Date() < this.tokenExpiresAt) {
      return; // Still valid
    }

    const path = '/oauth/token';
    const body = {
      username: this.config.sunsynkUsername,
      password: this.config.sunsynkPassword,
      grant_type: 'password',
      client_id: 'openapi',
    };
    const bodyStr = JSON.stringify(body);
    const md5 = this.calcMd5(bodyStr);
    const accept = 'application/json';
    const contentType = 'application/json';
    const { signature, nonce } = this.calcSignature('POST', accept, md5, contentType, path);

    const headers: Record<string, string> = {
      Accept: accept,
      'Content-Type': contentType,
      'Content-MD5': md5,
      'X-Ca-Key': this.config.sunsynkApiKey,
      'X-Ca-Nonce': nonce,
      'X-Ca-Signature': signature,
      'X-Ca-Signature-Headers': 'x-ca-key,x-ca-nonce',
    };

    const response = await axios.post<{ code: number; msg: string; data: SunsynkToken }>(
      OPENAPI_AUTH_URL + path,
      bodyStr,
      { headers, timeout: 30_000 },
    );

    if (response.data.code !== 0) {
      throw new Error('SunSynk auth failed: ' + response.data.msg);
    }

    const tokenData = response.data.data;
    this.accessToken = tokenData.access_token;
    // Token is valid for 7 days per SunSynk API; refresh 1 day early (7 - 1 = 6 days)
    this.tokenExpiresAt = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000);
  }

  /** Build Authorization header value. */
  private authHeader(): string {
    return 'Bearer ' + (this.accessToken ?? '');
  }

  /** Make an authenticated GET/POST request to api.sunsynk.net. */
  private async request<T = unknown>(
    method: 'GET' | 'POST',
    endpoint: string,
    data?: Record<string, unknown>,
    params?: Record<string, unknown>,
  ): Promise<T> {
    await this.authenticate();

    const requestHeaders: Record<string, string> = {
      Authorization: this.authHeader(),
      Accept: 'application/json',
    };

    if (data) {
      requestHeaders['Content-Type'] = 'application/json';
    }

    const response = await this.client.request<{ code: number; msg: string; data: T }>({
      method,
      url: endpoint,
      headers: requestHeaders,
      params: { lan: 'en', ...params },
      data,
    });

    if (response.status === 401) {
      // Token expired – clear and retry once
      this.accessToken = null;
      this.tokenExpiresAt = null;
      return this.request<T>(method, endpoint, data, params);
    }

    if (response.data.code !== 0) {
      throw new Error('SunSynk API error [' + response.data.code + ']: ' + response.data.msg);
    }

    return response.data.data;
  }

  // ===========================================================================
  // Plant & inverter discovery
  // ===========================================================================

  async getPlants(): Promise<SunsynkPlant[]> {
    const data = await this.request<{ infos: SunsynkPlant[] }>(
      'GET',
      '/api/v1/plants',
      undefined,
      { page: 1, limit: 10 },
    );
    return data.infos ?? [];
  }

  async getInverters(plantId: number): Promise<SunsynkInverter[]> {
    const data = await this.request<{ infos: SunsynkInverter[] }>(
      'GET',
      '/api/v1/plant/' + plantId + '/inverters',
      undefined,
      { page: 1, limit: 10 },
    );
    return data.infos ?? [];
  }

  /**
   * Discover the inverter serial to use.
   * Uses the configured serial/plant directly if provided, otherwise auto-discovers.
   */
  async discoverInverter(): Promise<{ plantId: number; serial: string }> {
    if (this.config.sunsynkPlantId && this.config.sunsynkSerial) {
      return { plantId: this.config.sunsynkPlantId, serial: this.config.sunsynkSerial };
    }

    const plants = await this.getPlants();
    if (!plants.length) throw new Error('No SunSynk plants found on this account');

    const plantId = plants[0].id;
    const inverters = await this.getInverters(plantId);
    if (!inverters.length) throw new Error('No inverters found for plant ' + plantId);

    // If serial configured, find matching; otherwise use the first inverter
    const serial = this.config.sunsynkSerial
      ? (inverters.find((i) => i.sn === this.config.sunsynkSerial)?.sn ?? inverters[0].sn)
      : inverters[0].sn;

    return { plantId, serial };
  }

  // ===========================================================================
  // Inverter settings
  // ===========================================================================

  /** Read all current inverter settings. */
  async getSettings(serial: string): Promise<InverterSettings> {
    return this.request<InverterSettings>('GET', '/api/v1/common/setting/' + serial + '/read');
  }

  /**
   * Write a partial settings update to the inverter.
   * Only settings in the ALLOWED_WRITE_SETTINGS whitelist are sent.
   */
  async updateSettings(serial: string, settings: Partial<InverterSettings>): Promise<void> {
    const safeSettings: Record<string, string> = {};

    for (const [key, value] of Object.entries(settings)) {
      if (!ALLOWED_WRITE_SETTINGS.has(key)) {
        console.warn('[SunsynkService] Skipping non-whitelisted setting: ' + key);
        continue;
      }
      if (value !== undefined) {
        safeSettings[key] = String(value);
      }
    }

    if (!Object.keys(safeSettings).length) {
      throw new Error('No allowed settings to write after whitelist filtering');
    }

    await this.request('POST', '/api/v1/common/setting/' + serial + '/set', safeSettings);
  }
}
