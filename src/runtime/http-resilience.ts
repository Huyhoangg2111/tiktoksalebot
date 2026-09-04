import axios, { type AxiosError, type InternalAxiosRequestConfig } from 'axios';

interface RetryableAxiosConfig extends InternalAxiosRequestConfig {
  __tiktokSaleBotRetryCount?: number;
}

const DEFAULT_HTTP_TIMEOUT_MS = 30_000;
const DEFAULT_HTTP_RETRIES = 2;
let configured = false;

function parsePositiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isSafeToRetry(config: RetryableAxiosConfig | undefined): boolean {
  if (!config) return false;

  const method = String(config.method || 'GET').toUpperCase();
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    return true;
  }

  // TikTok integrated report is read-only even though the API uses POST in some code paths.
  if (method === 'POST' && /\/report\//i.test(String(config.url || ''))) {
    return true;
  }

  return false;
}

function isRetryableFailure(error: AxiosError): boolean {
  const status = error.response?.status;
  if (status === 429 || (status !== undefined && status >= 500)) {
    return true;
  }

  if (!status) {
    const code = String(error.code || '').toUpperCase();
    return [
      'ECONNABORTED',
      'ETIMEDOUT',
      'ECONNRESET',
      'EAI_AGAIN',
      'ENOTFOUND',
      'ECONNREFUSED',
      'EPIPE',
    ].includes(code) || Boolean(error.request);
  }

  return false;
}

export function configureHttpResilience(): void {
  if (configured) return;
  configured = true;

  const timeoutMs = parsePositiveNumber(process.env.HTTP_TIMEOUT_MS, DEFAULT_HTTP_TIMEOUT_MS);
  const maxRetries = Math.max(
    0,
    Math.min(5, Math.trunc(parsePositiveNumber(process.env.HTTP_MAX_RETRIES, DEFAULT_HTTP_RETRIES)))
  );

  axios.defaults.timeout = timeoutMs;

  axios.interceptors.response.use(
    response => response,
    async (error: AxiosError) => {
      const requestConfig = error.config as RetryableAxiosConfig | undefined;

      if (!isSafeToRetry(requestConfig) || !isRetryableFailure(error)) {
        return Promise.reject(error);
      }

      const retryCount = requestConfig?.__tiktokSaleBotRetryCount || 0;
      if (!requestConfig || retryCount >= maxRetries) {
        return Promise.reject(error);
      }

      requestConfig.__tiktokSaleBotRetryCount = retryCount + 1;
      const retryNumber = retryCount + 1;
      const delayMs = Math.min(5_000, 500 * (2 ** retryCount)) + Math.floor(Math.random() * 250);

      console.warn(
        `[HTTP] Retrying ${String(requestConfig.method || 'GET').toUpperCase()} ${requestConfig.url || ''} ` +
        `(${retryNumber}/${maxRetries}) after ${delayMs}ms: ${error.code || error.response?.status || error.message}`
      );

      await sleep(delayMs);
      return axios.request(requestConfig);
    }
  );

  console.log(`[HTTP] Resilience enabled: timeout=${timeoutMs}ms, safe retries=${maxRetries}`);
}
