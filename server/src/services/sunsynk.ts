/**
 * SunSynk Cloud API service.
 *
 * Authentication (csp-web browser flow, mirrors api.sunsynk.net/login):
 *   1. GET  https://api.sunsynk.net/anonymous/publicKey  -> RSA public key
 *   2. POST https://api.sunsynk.net/oauth/token/new       -> access token
 *   The password is RSA (PKCS#1 v1.5) encrypted with the fetched public key,
 *   and each request carries a millisecond `nonce` + hex-MD5 `sign`.
 *
 * Data / Control: https://api.sunsynk.net
 *   All endpoints use a bearer token obtained during auth.
 *
 * Reference: https://github.com/hermitdave/SunSynk-Octopus
 */
import axios, { AxiosInstance } from 'axios';
import * as crypto from 'crypto';
import * as https from 'https';
import { Config } from '../config';
import {
  InverterSettings,
  SunsynkEnergyFlow,
  SunsynkPlantOverview,
  SunsynkPowerGraph,
  SunsynkToken,
} from '../types';

const API_DATA_URL = 'https://api.sunsynk.net';
const APP_PORTAL_URL = 'https://app.sunsynk.net';

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

/**
 * Time-of-use slot boundaries that must always frame the off-peak window
 * (23:30 -> 05:30). The charge scheduler assumes the inverter's Use Timer
 * slots line up with this window, so these boundaries are validated on every
 * read and re-asserted on every write to keep the inverter in step.
 */
const REQUIRED_OFF_PEAK_SELL_TIMES: Record<string, string> = {
  sellTime1: '00:00',
  sellTime2: '05:30',
  sellTime6: '23:30',
};

export class SunsynkService {
  private config: Config;
  private client: AxiosInstance;
  private portalClient: AxiosInstance;
  private authClient: AxiosInstance;
  private accessToken: string | null = null;
  private tokenExpiresAt: Date | null = null;

  private mask(value: string, keepStart = 4, keepEnd = 4): string {
    if (!value) return '';
    if (value.length <= keepStart + keepEnd) return '*'.repeat(value.length);
    return value.slice(0, keepStart) + '*'.repeat(value.length - keepStart - keepEnd) + value.slice(-keepEnd);
  }

  private authDebug(message: string, meta?: Record<string, unknown>): void {
    const payload = meta ? ' ' + JSON.stringify(meta) : '';
    console.log('[SunsynkAuth][DEBUG] ' + message + payload);
  }

  private portalDebug(message: string, meta?: Record<string, unknown>): void {
    const payload = meta ? ' ' + JSON.stringify(meta) : '';
    console.log('[SunsynkPortal][DEBUG] ' + message + payload);
  }

  constructor(config: Config) {
    this.config = config;
    const httpsAgent = new https.Agent({
      rejectUnauthorized: this.config.sunsynkVerifySsl,
    });

    this.client = axios.create({
      baseURL: API_DATA_URL,
      timeout: 30_000,
      httpsAgent,
    });

    this.portalClient = axios.create({
      baseURL: APP_PORTAL_URL,
      timeout: 30_000,
      httpsAgent,
    });

    this.authClient = axios.create({
      baseURL: API_DATA_URL,
      timeout: 30_000,
      httpsAgent,
    });
  }

  /** Make an authenticated request to app.sunsynk.net portal endpoints. */
  private async requestPortal<T = unknown>(
    method: 'GET' | 'POST',
    endpoint: string,
    data?: Record<string, unknown>,
    params?: Record<string, unknown>,
  ): Promise<T> {
    await this.authenticate();

    this.portalDebug('Request start', {
      method,
      endpoint,
      params: params ?? null,
    });

    const requestHeaders: Record<string, string> = {
      Authorization: this.authHeader(),
      Accept: 'application/json',
      'Accept-Language': 'en-GB,en;q=0.9',
      'User-Agent': 'IntelligentSunsynk/1.0',
    };

    if (data) {
      requestHeaders['Content-Type'] = 'application/json';
    }

    let response;
    try {
      response = await this.portalClient.request<
        | { code?: number; msg?: string; data?: T }
        | T
      >({
        method,
        url: endpoint,
        headers: requestHeaders,
        params,
        data,
      });
    } catch (err) {
      if (axios.isAxiosError(err)) {
        this.portalDebug('Request failed', {
          method,
          endpoint,
          params: params ?? null,
          status: err.response?.status,
          statusText: err.response?.statusText,
          responseData: err.response?.data,
          code: err.code,
          message: err.message,
        });
      } else {
        this.portalDebug('Request failed with non-axios error', {
          method,
          endpoint,
          params: params ?? null,
          error: String(err),
        });
      }
      throw err;
    }

    this.portalDebug('Request success', {
      method,
      endpoint,
      params: params ?? null,
      status: response.status,
    });

    if (response.status === 401) {
      this.accessToken = null;
      this.tokenExpiresAt = null;
      return this.requestPortal<T>(method, endpoint, data, params);
    }

    const payload = response.data;
    if (
      payload &&
      typeof payload === 'object' &&
      !Array.isArray(payload) &&
      'code' in payload
    ) {
      const wrapped = payload as { code?: number; msg?: string; data?: T };
      if (typeof wrapped.code === 'number' && wrapped.code !== 0) {
        throw new Error('SunSynk portal API error [' + wrapped.code + ']: ' + (wrapped.msg ?? 'Unknown error'));
      }
      if ('data' in wrapped) {
        return wrapped.data as T;
      }
    }

    return payload as T;
  }

  // ===========================================================================
  // Authentication
  // ===========================================================================

  /** Hex-encoded MD5 digest, as used by the SunSynk `sign` request parameter. */
  private md5Hex(data: string): string {
    return crypto.createHash('md5').update(data, 'utf8').digest('hex');
  }

  /** The `source` identifier the api.sunsynk.net web portal sends. */
  private readonly authSource = 'sunsynk';

  /**
   * Fetch the RSA public key used to encrypt the password.
   *
   * Mirrors the browser flow: GET /anonymous/publicKey with a millisecond
   * `nonce` and a hex-MD5 `sign` of `nonce=<n>&source=<src>` + "POWER_VIEW".
   * Returns the base64 DER (X.509 SubjectPublicKeyInfo) public key string.
   */
  private async fetchPublicKey(): Promise<string> {
    const nonce = Date.now();
    const base = `nonce=${nonce}&source=${this.authSource}`;
    const sign = this.md5Hex(base + 'POWER_VIEW');
    const url = `/anonymous/publicKey?${base}&sign=${sign}`;

    const response = await this.authClient.get<{ code: number; msg: string; data: string }>(url, {
      headers: { accept: 'application/json' },
    });

    if (response.data.code !== 0 || !response.data.data) {
      throw new Error('SunSynk publicKey fetch failed: ' + (response.data.msg || 'Unknown error'));
    }

    this.authDebug('Fetched OpenAPI public key', {
      nonce,
      keyLength: response.data.data.length,
      keyPreview: this.mask(response.data.data, 10, 0),
    });

    return response.data.data;
  }

  /**
   * RSA-encrypt the password with the fetched public key (PKCS#1 v1.5 padding,
   * matching JSEncrypt in the browser) and return a base64 string.
   */
  private encryptPassword(password: string, publicKeyBase64: string): string {
    const keyObject = crypto.createPublicKey({
      key: Buffer.from(publicKeyBase64, 'base64'),
      format: 'der',
      type: 'spki',
    });
    return crypto
      .publicEncrypt(
        { key: keyObject, padding: crypto.constants.RSA_PKCS1_PADDING },
        Buffer.from(password, 'utf8'),
      )
      .toString('base64');
  }

  /**
   * Build the csp-web auth request exactly as the api.sunsynk.net login page
   * does: fetch the RSA public key, encrypt the password, then sign the token
   * request with a fresh millisecond `nonce` + hex-MD5 `sign` of
   * `nonce=<n>&source=<src>` + the first 10 chars of the public key.
   */
  private async buildAuthRequest(): Promise<{
    path: string;
    bodyStr: string;
    headers: Record<string, string>;
  }> {
    const publicKey = await this.fetchPublicKey();

    const nonce = Date.now();
    const base = `nonce=${nonce}&source=${this.authSource}`;
    const sign = this.md5Hex(base + publicKey.substring(0, 10));
    const encryptedPassword = this.encryptPassword(this.config.sunsynkPassword, publicKey);

    const path = '/oauth/token/new';
    const bodyStr = JSON.stringify({
      sign,
      nonce,
      username: this.config.sunsynkUsername,
      password: encryptedPassword,
      grant_type: 'password',
      client_id: 'csp-web',
      source: this.authSource,
    });

    const headers: Record<string, string> = {
      accept: 'application/json',
      'content-type': 'application/json;charset=UTF-8',
    };

    this.authDebug('Built csp-web auth request', {
      path,
      username: this.config.sunsynkUsername,
      nonce,
      signPreview: this.mask(sign, 8, 6),
      encryptedPasswordLength: encryptedPassword.length,
      bodyLength: bodyStr.length,
      verifySsl: this.config.sunsynkVerifySsl,
    });

    return { path, bodyStr, headers };
  }

  /** Refresh 1 hour early, but never less than 5 minutes from now. */
  private calcTokenExpiry(expiresInSeconds: number | undefined): Date {
    const expiresInMs = Math.max((expiresInSeconds ?? 7 * 24 * 60 * 60) * 1000, 5 * 60 * 1000);
    const refreshSkewMs = Math.min(60 * 60 * 1000, Math.floor(expiresInMs / 2));
    return new Date(Date.now() + Math.max(expiresInMs - refreshSkewMs, 5 * 60 * 1000));
  }

  /**
   * Obtain an access token from openapi.sunsynk.net using OpenAPI credentials.
   * Token is cached and refreshed before expiry (7-day lifetime, refresh at 6 days).
   */
  async authenticate(): Promise<void> {
    if (this.accessToken && this.tokenExpiresAt && new Date() < this.tokenExpiresAt) {
      return; // Still valid
    }

    if (this.config.sunsynkAccessToken) {
      this.accessToken = this.config.sunsynkAccessToken;
      // Manual tokens cannot be refreshed automatically; assume 7-day validity
      // and reuse until expiry or a 401 forces the user to replace it.
      this.tokenExpiresAt = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000);
      console.log('[SunsynkService] Using manual SUNSYNK_ACCESS_TOKEN from environment');
      this.authDebug('Manual access token path selected', {
        tokenMasked: this.mask(this.config.sunsynkAccessToken, 8, 6),
      });
      return;
    }

    const { path, bodyStr, headers } = await this.buildAuthRequest();

    let response;
    try {
      response = await this.authClient.post<{ code: number; msg: string; data: SunsynkToken }>(
        path,
        bodyStr,
        { headers },
      );
    } catch (err) {
      if (axios.isAxiosError(err)) {
        this.authDebug('HTTP error during OpenAPI auth request', {
          status: err.response?.status,
          statusText: err.response?.statusText,
          responseData: err.response?.data,
          code: err.code,
          message: err.message,
        });
      }
      throw err;
    }

    this.authDebug('OpenAPI auth HTTP response received', {
      status: response.status,
      responseCode: response.data?.code,
      responseMsg: response.data?.msg,
      hasData: Boolean(response.data?.data),
      tokenType: response.data?.data?.token_type,
      expiresIn: response.data?.data?.expires_in,
    });

    if (response.data.code !== 0) {
      const detail = response.data.msg || 'Unknown error';
      // 102 = "Account or password error" (invalid SUNSYNK_USERNAME/SUNSYNK_PASSWORD).
      if (response.data.code === 102) {
        throw new Error(
          'SunSynk auth failed: ' + detail +
          '. Check SUNSYNK_USERNAME and SUNSYNK_PASSWORD in .env. ' +
          'As a fallback, add SUNSYNK_ACCESS_TOKEN to .env and restart the server.'
        );
      }

      throw new Error('SunSynk auth failed: ' + detail);
    }

    const tokenData = response.data.data;
    this.accessToken = tokenData.access_token;
    this.tokenExpiresAt = this.calcTokenExpiry(tokenData.expires_in);
    this.authDebug('OpenAPI auth token accepted', {
      tokenMasked: this.mask(tokenData.access_token, 10, 8),
      refreshTokenMasked: this.mask(tokenData.refresh_token ?? '', 10, 8),
      tokenType: tokenData.token_type,
      expiresIn: tokenData.expires_in,
      refreshAt: this.tokenExpiresAt.toISOString(),
    });
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
  // Inverter settings
  // ===========================================================================

  /**
   * Normalise a SunSynk "HH:MM" time-of-day value for comparison.
   * Accepts unpadded hours (e.g. "0:00") and returns zero-padded "HH:MM",
   * or null if the value is missing/unparseable.
   */
  private normalizeTimeOfDay(value: string | undefined): string | null {
    if (!value) return null;
    const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) return null;
    return String(hours).padStart(2, '0') + ':' + String(minutes).padStart(2, '0');
  }

  /**
   * Ensure the off-peak slot boundaries on the inverter match the required
   * window (see REQUIRED_OFF_PEAK_SELL_TIMES). If any have drifted, correct
   * them on the inverter and return the settings with the corrected values.
   */
  private async ensureOffPeakBoundaries(
    serial: string,
    settings: InverterSettings,
  ): Promise<InverterSettings> {
    const corrections: Record<string, string> = {};

    for (const [key, expected] of Object.entries(REQUIRED_OFF_PEAK_SELL_TIMES)) {
      if (this.normalizeTimeOfDay(settings[key]) !== expected) {
        corrections[key] = expected;
        console.warn(
          '[SunsynkService] ' + key + ' is "' + (settings[key] ?? 'unset') +
          '", expected "' + expected + '" for the 23:30-05:30 off-peak window; correcting.',
        );
      }
    }

    if (!Object.keys(corrections).length) {
      return settings;
    }

    await this.request('POST', '/api/v1/common/setting/' + serial + '/set', corrections);
    return { ...settings, ...corrections };
  }

  /** Read all current inverter settings. */
  async getSettings(serial: string): Promise<InverterSettings> {
    const settings = await this.request<InverterSettings>(
      'GET',
      '/api/v1/common/setting/' + serial + '/read',
    );
    return this.ensureOffPeakBoundaries(serial, settings);
  }

  /**
   * Write a partial settings update to the inverter.
   * Only settings in the ALLOWED_WRITE_SETTINGS whitelist are sent.
   */
  async updateSettings(serial: string, settings: Partial<InverterSettings>): Promise<void> {
    // Re-assert the off-peak slot boundaries on every write so the inverter
    // never drifts out of the required 23:30-05:30 window. A caller supplying a
    // conflicting value is overridden and warned rather than silently obeyed.
    const settingsToWrite: Partial<InverterSettings> = { ...settings };
    for (const [key, expected] of Object.entries(REQUIRED_OFF_PEAK_SELL_TIMES)) {
      const provided = settingsToWrite[key];
      if (provided !== undefined && this.normalizeTimeOfDay(provided) !== expected) {
        console.warn(
          '[SunsynkService] Overriding ' + key + '="' + provided +
          '" with required off-peak boundary "' + expected + '".',
        );
      }
      settingsToWrite[key] = expected;
    }

    const safeSettings: Record<string, string> = {};

    for (const [key, value] of Object.entries(settingsToWrite)) {
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

  /** Read current plant overview data. */
  async getPlantOverview(plantId: number): Promise<SunsynkPlantOverview> {
    const endpoint = '/api/v2/plant/' + plantId + '/overview';
    this.portalDebug('Fetching plant overview', { plantId, endpoint });
    try {
      const overview = await this.requestPortal<SunsynkPlantOverview>('GET', endpoint);
      this.portalDebug('Plant overview fetched', {
        plantId,
        topLevelKeys: Object.keys(overview ?? {}).slice(0, 20),
      });
      return overview;
    } catch (err) {
      if (axios.isAxiosError(err)) {
        this.portalDebug('Plant overview fetch failed', {
          plantId,
          endpoint,
          status: err.response?.status,
          statusText: err.response?.statusText,
          responseData: err.response?.data,
          message: err.message,
        });
      } else {
        this.portalDebug('Plant overview fetch failed with non-axios error', {
          plantId,
          endpoint,
          error: String(err),
        });
      }
      throw err;
    }
  }

  /** Read plant storage power graph data for a specific date. */
  async getPlantPowerGraph(
    plantId: number,
    date: string,
    language = 'en',
  ): Promise<SunsynkPowerGraph> {
    return this.requestPortal<SunsynkPowerGraph>(
      'GET',
      '/api/v2/plant/' + plantId + '/storage/power',
      undefined,
      { date, id: plantId, language },
    );
  }

  /** Read current plant energy flow data. */
  async getPlantEnergyFlow(plantId: number): Promise<SunsynkEnergyFlow> {
    return this.requestPortal<SunsynkEnergyFlow>('GET', '/api/v2/plant/' + plantId + '/energy/flow');
  }

  /**
   * Read battery state of charge (SoC) from the plant energy-flow endpoint.
   * Returns SoC as a percentage (0-100), or null if not available.
   *
   * NOTE: the plant *overview* endpoint does NOT include SoC — it lives in the
   * `energy/flow` payload as `soc`.
   */
  async getBatterySoC(plantId: number): Promise<number | null> {
    const flow = await this.getPlantEnergyFlow(plantId);
    const soc = (flow as Record<string, unknown>).soc;
    if (typeof soc === 'number') {
      return soc;
    }
    if (typeof soc === 'string') {
      const parsed = parseFloat(soc);
      if (!isNaN(parsed)) {
        return parsed;
      }
    }
    return null;
  }
}
