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
import * as https from 'https';
import { Config } from '../config';
import { InverterSettings, SunsynkToken } from '../types';

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

    this.authClient = axios.create({
      baseURL: OPENAPI_AUTH_URL,
      timeout: 30_000,
      httpsAgent,
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

  /**
   * Build the OpenAPI auth request exactly as described in SunSynk's support
   * article. The signature logic intentionally mirrors their browser example.
   */
  private buildAuthRequest(): {
    path: string;
    bodyStr: string;
    headers: Record<string, string>;
  } {
    const path = '/oauth/token';
    const bodyStr = JSON.stringify({
      username: this.config.sunsynkUsername,
      password: this.config.sunsynkPassword,
      grant_type: 'password',
      client_id: 'openapi',
    });
    const nonce = crypto.randomUUID();
    const md5 = this.calcMd5(bodyStr);

    const headers: Record<string, string> = {
      accept: 'application/json',
      'content-type': 'application/json',
      'Content-MD5': md5,
      'X-Ca-Nonce': nonce,
      'X-Ca-Key': this.config.sunsynkApiKey,
    };

    const headersToSign = new Map<string, string>();
    headersToSign.set('x-ca-key', this.config.sunsynkApiKey);
    headersToSign.set('x-ca-nonce', nonce);

    const signatureHeaders = Array.from(headersToSign.keys()).sort().join(',');
    const textToSign = [
      'POST',
      headers.accept,
      md5,
      headers['content-type'],
      '',
      ...Array.from(headersToSign.entries())
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => key + ':' + value),
      path,
    ].join('\n');

    const signature = crypto
      .createHmac('sha256', this.config.sunsynkApiSecret)
      .update(textToSign, 'utf8')
      .digest('base64');

    headers['X-Ca-Signature'] = signature;
    headers['X-Ca-Signature-Headers'] = signatureHeaders;

    this.authDebug('Built OpenAPI auth request', {
      path,
      username: this.config.sunsynkUsername,
      apiKeyMasked: this.mask(this.config.sunsynkApiKey),
      nonce,
      contentMd5: md5,
      signatureHeaders,
      signaturePreview: this.mask(signature, 8, 6),
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

    const { path, bodyStr, headers } = this.buildAuthRequest();

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
      if (detail.toLowerCase().includes('account or password error')) {
        throw new Error(
          'SunSynk auth failed: ' + detail +
          '. SunSynk may now require the newer RSA login flow. ' +
          'As a workaround, add SUNSYNK_ACCESS_TOKEN to .env and restart the server.'
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
