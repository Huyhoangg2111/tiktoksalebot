/**
 * OMO Captcha Client cho TikTok
 * Port từ C# OmoCaptchaClient.cs sang TypeScript
 * Hỗ trợ: Tiktok3DSelectObjectWebTask, TiktokSelectObjectWebTask,
 *          TiktokRotateWebTask, TiktokSliderWebTask
 *
 * Docs: https://docs.omocaptcha.com/tai-lieu-api/tiktok
 */

import axios from 'axios';

// ============================================================
// Types
// ============================================================

export interface OmoCaptchaConfig {
  apiKey: string;
  createTaskUrl?: string;
  getTaskResultUrl?: string;
  maxPollAttempts?: number;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export interface OmoCreateTaskResponse {
  errorId: number;
  taskId?: string;
  errorCode?: string;
  errorDescription?: string;
}

export interface OmoPoint {
  x: number;
  y: number;
}

export interface Omo3DSelectSolution {
  pointA: OmoPoint;
  pointB: OmoPoint;
}

export interface OmoSelectObjectSolution {
  objects: number[];
}

export interface OmoRotateSolution {
  rotate: number; // tỷ lệ 0-1
}

export interface OmoSliderSolution {
  end: { x: number };
}

export interface OmoGetTaskResultResponse {
  errorId: number;
  status?: string;
  errorCode?: string;
  errorDescription?: string;
  solution?: Record<string, unknown>;
}

export type CaptchaType =
  | 'Tiktok3DSelectObjectWebTask'
  | 'TiktokSelectObjectWebTask'
  | 'TiktokRotateWebTask'
  | 'TiktokSliderWebTask';

type StatusCallback = (message: string) => void;

// ============================================================
// Constants
// ============================================================

const DEFAULT_CREATE_TASK_URL = 'https://api.omocaptcha.com/v2/createTask';
const DEFAULT_GET_TASK_RESULT_URL = 'https://api.omocaptcha.com/v2/getTaskResult';
const DEFAULT_MAX_POLL_ATTEMPTS = 24; // 24 * 2.5s = 60s
const DEFAULT_POLL_INTERVAL_MS = 2500;
const DEFAULT_TIMEOUT_MS = 25000;

// ============================================================
// OMO Captcha Client
// ============================================================

export class OmoCaptchaClient {
  private readonly config: Required<OmoCaptchaConfig>;

  constructor(config: OmoCaptchaConfig) {
    this.config = {
      apiKey: config.apiKey,
      createTaskUrl: config.createTaskUrl || DEFAULT_CREATE_TASK_URL,
      getTaskResultUrl: config.getTaskResultUrl || DEFAULT_GET_TASK_RESULT_URL,
      maxPollAttempts: config.maxPollAttempts || DEFAULT_MAX_POLL_ATTEMPTS,
      pollIntervalMs: config.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS,
      timeoutMs: config.timeoutMs || DEFAULT_TIMEOUT_MS,
    };
  }

  // ----------------------------------------------------------
  // Tiktok3DSelectObjectWebTask
  // Chọn 2 đối tượng 3D trên web
  // Response: { pointA: {x, y}, pointB: {x, y} }
  // ----------------------------------------------------------
  async solve3DSelectObject(
    imageBase64: string,
    widthView: number,
    heightView: number,
    onStatus?: StatusCallback,
  ): Promise<Omo3DSelectSolution | null> {
    const taskPayload = {
      type: 'Tiktok3DSelectObjectWebTask' as const,
      imageBase64,
      widthView,
      heightView,
    };

    const result = await this.createAndPoll(taskPayload, onStatus, '3DSelect');
    if (!result?.solution) return null;

    const solution = result.solution as {
      pointA?: OmoPoint;
      pointB?: OmoPoint;
    };

    if (solution.pointA && solution.pointB) {
      return {
        pointA: solution.pointA,
        pointB: solution.pointB,
      };
    }

    return null;
  }

  // ----------------------------------------------------------
  // TiktokSelectObjectWebTask
  // Chọn đối tượng đúng trên web
  // Response: { objects: [0, 1, 3] } (chỉ số các ô cần click)
  // ----------------------------------------------------------
  async solveSelectObject(
    imageBase64: string,
    question: string,
    onStatus?: StatusCallback,
  ): Promise<OmoSelectObjectSolution | null> {
    const taskPayload = {
      type: 'TiktokSelectObjectWebTask' as const,
      imageBase64,
      question,
    };

    const result = await this.createAndPoll(taskPayload, onStatus, 'SelectObj');
    if (!result?.solution) return null;

    const solution = result.solution as { objects?: number[] };
    if (solution.objects && Array.isArray(solution.objects)) {
      return { objects: solution.objects };
    }

    return null;
  }

  // ----------------------------------------------------------
  // TiktokRotateWebTask
  // Xoay ảnh cho đúng
  // Response: { rotate: 0.76 } (tỷ lệ 0-1)
  // ----------------------------------------------------------
  async solveRotate(
    insideImageBase64: string,
    outsideImageBase64: string,
    onStatus?: StatusCallback,
  ): Promise<OmoRotateSolution | null> {
    const taskPayload = {
      type: 'TiktokRotateWebTask' as const,
      imageBase64s: [insideImageBase64, outsideImageBase64],
    };

    const result = await this.createAndPoll(taskPayload, onStatus, 'Rotate');
    if (!result?.solution) return null;

    const solution = result.solution as { rotate?: number };
    if (solution.rotate !== undefined) {
      return { rotate: solution.rotate };
    }

    return null;
  }

  // ----------------------------------------------------------
  // TiktokSliderWebTask
  // Kéo slider puzzle
  // Response: { end: { x: 150 } }
  // ----------------------------------------------------------
  async solveSlider(
    imageBase64: string,
    widthView: number,
    onStatus?: StatusCallback,
  ): Promise<OmoSliderSolution | null> {
    const taskPayload = {
      type: 'TiktokSliderWebTask' as const,
      imageBase64,
      widthView,
    };

    const result = await this.createAndPoll(taskPayload, onStatus, 'Slider');
    if (!result?.solution) return null;

    const solution = result.solution as { end?: { x: number } };
    if (solution.end?.x !== undefined) {
      return { end: { x: solution.end.x } };
    }

    return null;
  }

  // ----------------------------------------------------------
  // Internal: createTask + poll getTaskResult
  // ----------------------------------------------------------
  private async createAndPoll(
    task: Record<string, unknown>,
    onStatus?: StatusCallback,
    label = 'Captcha',
  ): Promise<OmoGetTaskResultResponse | null> {
    if (!this.config.apiKey) {
      this.safeStatus(onStatus, `${label}: chua cau hinh OMO API key.`);
      return null;
    }

    try {
      // Step 1: createTask
      this.safeStatus(onStatus, `${label}: dang gui yeu cau OMO...`);
      const createResponse = await this.postJson<OmoCreateTaskResponse>(
        this.config.createTaskUrl,
        {
          clientKey: this.config.apiKey,
          task,
        },
      );

      if (!createResponse) {
        this.safeStatus(onStatus, `${label}: OMO khong phan hoi createTask.`);
        return null;
      }

      if (createResponse.errorId !== 0) {
        this.safeStatus(
          onStatus,
          `${label}: createTask loi (${createResponse.errorCode || 'UNKNOWN'}: ${createResponse.errorDescription || ''}).`,
        );
        return null;
      }

      if (!createResponse.taskId) {
        this.safeStatus(onStatus, `${label}: OMO khong tra ve taskId.`);
        return null;
      }

      this.safeStatus(
        onStatus,
        `${label}: da tao task (${createResponse.taskId.substring(0, 8)}...), dang cho ket qua...`,
      );

      // Step 2: poll getTaskResult
      return await this.pollTaskResult(createResponse.taskId, onStatus, label);
    } catch (error) {
      this.safeStatus(
        onStatus,
        `${label} Error: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  private async pollTaskResult(
    taskId: string,
    onStatus?: StatusCallback,
    label = 'Captcha',
  ): Promise<OmoGetTaskResultResponse | null> {
    for (let i = 0; i < this.config.maxPollAttempts; i++) {
      await this.sleep(this.config.pollIntervalMs);

      const pollResponse = await this.postJson<OmoGetTaskResultResponse>(
        this.config.getTaskResultUrl,
        {
          clientKey: this.config.apiKey,
          taskId,
        },
      );

      if (!pollResponse) {
        if (i % 4 === 0) {
          this.safeStatus(onStatus, `${label}: OMO khong phan hoi, dang thu lai...`);
        }
        continue;
      }

      const status = (pollResponse.status || '').trim().toLowerCase();

      // Check error
      if (pollResponse.errorId !== 0) {
        const errCode = (pollResponse.errorCode || '').trim();
        if (
          errCode === 'ERROR_JOB_STATUS' ||
          errCode === 'CAPCHA_NOT_READY' ||
          errCode === 'CAPTCHA_NOT_READY'
        ) {
          if (i % 4 === 0) {
            this.safeStatus(onStatus, `${label}: OMO dang xu ly...`);
          }
          continue;
        }

        this.safeStatus(
          onStatus,
          `${label}: getTaskResult loi (${errCode || 'UNKNOWN'}: ${pollResponse.errorDescription || ''}).`,
        );
        return null;
      }

      // Ready / Success
      if (status === 'ready' || status === 'success') {
        if (pollResponse.solution && Object.keys(pollResponse.solution).length > 0) {
          this.safeStatus(onStatus, `${label}: OMO tra ket qua thanh cong!`);
          return pollResponse;
        }
        this.safeStatus(onStatus, `${label}: OMO bao ready nhung solution rong.`);
        continue;
      }

      // Failed
      if (status === 'fail' || status === 'failed' || status === 'error') {
        this.safeStatus(
          onStatus,
          `${label}: OMO bao fail (${pollResponse.errorCode || 'UNKNOWN'}).`,
        );
        return null;
      }

      // Processing
      if (
        status === 'processing' ||
        status === 'running' ||
        status === 'queued' ||
        status === 'pending' ||
        status === 'waiting' ||
        !status
      ) {
        if (i % 4 === 0) {
          this.safeStatus(onStatus, `${label}: OMO dang xu ly... (${status || 'waiting'})`);
        }
        continue;
      }

      if (i % 4 === 0) {
        this.safeStatus(onStatus, `${label}: trang thai la '${status}', dang cho them...`);
      }
    }

    this.safeStatus(
      onStatus,
      `${label}: timeout sau ${Math.round((this.config.maxPollAttempts * this.config.pollIntervalMs) / 1000)} giay.`,
    );
    return null;
  }

  // ----------------------------------------------------------
  // HTTP helper
  // ----------------------------------------------------------
  private async postJson<T>(url: string, payload: Record<string, unknown>): Promise<T | null> {
    try {
      const response = await axios.post(url, payload, {
        timeout: this.config.timeoutMs,
        headers: { 'Content-Type': 'application/json' },
      });
      return response.data as T;
    } catch {
      return null;
    }
  }

  private safeStatus(onStatus: StatusCallback | undefined, message: string): void {
    if (!message) return;
    try {
      onStatus?.(message);
    } catch {
      // ignore
    }
    console.log(`[omo-captcha] ${message}`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
