/**
 * Captcha Handler - Tự động phát hiện và giải captcha TikTok trên trang web
 * Sử dụng Playwright + OMO Captcha API
 *
 * Hỗ trợ:
 * - 3D Select Object (chọn 2 đối tượng 3D)
 * - Select Object (chọn đối tượng đúng)
 * - Rotate (xoay ảnh)
 * - Slider (kéo thanh trượt)
 */

import type { Page, ElementHandle, Frame } from 'playwright';
import { OmoCaptchaClient, type CaptchaType } from './omo-captcha.js';

// ============================================================
// Types
// ============================================================

export interface CaptchaHandlerConfig {
  omoCaptchaApiKey: string;
  maxRetries?: number;
  /** ms to wait before checking for captcha */
  checkDelayMs?: number;
  /** ms to wait between captcha solve retries */
  retryDelayMs?: number;
}

export interface CaptchaDetection {
  detected: boolean;
  type?: CaptchaType;
  frame?: Frame;
  /** Captcha container element */
  containerSelector?: string;
}

type StatusCallback = (message: string) => void;

// ============================================================
// Captcha Selectors
// ============================================================

/**
 * Các CSS selector để detect captcha trên TikTok Ads Manager
 * TikTok thường dùng captcha iframe từ verify.snssdk.com hoặc inline
 */
const CAPTCHA_SELECTORS = {
  // Container chính - bao gồm cả TikTok TUXModal
  captchaContainer: [
    '#captcha_container',
    '.captcha_verify_container',
    '#tiktok-verify-ele',
    '[data-testid="captcha"]',
    '.verify-captcha-container',
    '#captcha-verify-image',
    'div[class*="captcha"]',
    'div[id*="captcha"]',
    // TikTok modal that contains captcha
    '.TUXModal-overlay',
  ],
  // 3D Select Object
  select3DImage: [
    '.verify-captcha-submit-button',
    'img[class*="captcha"][class*="3d"]',
    '.captcha-verify-image img',
    // TikTok modal captcha image
    '.TUXModal-overlay img',
    '[data-floating-ui-portal] img',
  ],
  // Slider captcha
  sliderTrack: [
    '.secsdk-captcha-drag-icon',
    '.captcha_verify_slide--button',
    '[class*="slider"][class*="button"]',
    '.verify-captcha-slider',
  ],
  sliderImage: [
    '.captcha_verify_img_slide',
    'img[class*="captcha"][class*="slide"]',
  ],
  // Rotate captcha
  rotateInner: [
    '.captcha-verify-rotate-inner img',
    'img[class*="rotate-inner"]',
  ],
  rotateOuter: [
    '.captcha-verify-rotate-outer img',
    'img[class*="rotate-outer"]',
  ],
  // Select object
  selectObjectImage: [
    '.captcha-verify-image img',
    '.verify-captcha-image img',
  ],
  // Captcha image (generic) - cả trong modal lẫn ngoài
  captchaImage: [
    '#captcha-verify-image',
    '.captcha_verify_img_slide',
    'img.captcha-verify-image',
    'img[src*="captcha"]',
    '.verify-image img',
    // TikTok modal captcha - ảnh nằm trong modal
    '.TUXModal-overlay img[src]:not([src=""])',
    '[data-floating-ui-portal] img[src]:not([src=""])',
  ],
  // Confirm/Submit button trong captcha modal
  captchaSubmit: [
    '.TUXModal-overlay button:has-text("Confirm")',
    '.TUXModal-overlay button:has-text("Submit")',
    '.TUXModal-overlay button:has-text("Xác nhận")',
    'button:has-text("Confirm")',
    '.verify-captcha-submit-button',
    '#secsdk-captcha-drag-wrapper button',
  ],
  // Text markers
  captchaTextMarkers: [
    'drag the slider',
    'slide to verify',
    'select 2 objects',
    'select two objects',
    'select the same object',
    'same shape',
    'rotate',
    'drag the puzzle piece',
    'verify to continue',
    'verification',
  ],
};

// ============================================================
// CaptchaHandler
// ============================================================

export class CaptchaHandler {
  private omoClient: OmoCaptchaClient;
  private maxRetries: number;
  private checkDelayMs: number;
  private retryDelayMs: number;

  constructor(config: CaptchaHandlerConfig) {
    this.omoClient = new OmoCaptchaClient({ apiKey: config.omoCaptchaApiKey });
    this.maxRetries = config.maxRetries ?? 3;
    this.checkDelayMs = config.checkDelayMs ?? 2000;
    this.retryDelayMs = config.retryDelayMs ?? 3000;
  }

  /**
   * Kiểm tra xem trang hiện tại có captcha không
   */
  async detectCaptcha(page: Page): Promise<CaptchaDetection> {
    // Check main page
    const mainResult = await this.detectCaptchaInContext(page);
    if (mainResult.detected) return mainResult;

    // Check all iframes
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      try {
        const frameResult = await this.detectCaptchaInFrame(frame);
        if (frameResult.detected) return frameResult;
      } catch {
        // frame might be detached
      }
    }

    return { detected: false };
  }

  /**
   * Tự động giải captcha nếu phát hiện
   * @returns true nếu captcha được giải thành công hoặc không có captcha
   */
  async handleCaptcha(
    page: Page,
    onStatus?: StatusCallback,
  ): Promise<boolean> {
    await this.sleep(this.checkDelayMs);

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      const detection = await this.detectCaptcha(page);

      if (!detection.detected) {
        this.safeStatus(onStatus, 'Khong phat hien captcha.');
        return true;
      }

      this.safeStatus(
        onStatus,
        `Phat hien captcha: ${detection.type || 'unknown'} (lan thu ${attempt + 1}/${this.maxRetries})`,
      );

      try {
        const solved = await this.solveCaptcha(page, detection, onStatus);
        if (solved) {
          this.safeStatus(onStatus, 'Da giai captcha thanh cong!');
          // Wait for captcha to be verified
          await this.sleep(2000);
          // Check if captcha is gone
          const recheck = await this.detectCaptcha(page);
          if (!recheck.detected) {
            return true;
          }
          this.safeStatus(onStatus, 'Captcha van con, dang thu lai...');
        } else {
          this.safeStatus(onStatus, 'Giai captcha that bai, dang thu lai...');
        }
      } catch (error) {
        this.safeStatus(
          onStatus,
          `Loi khi giai captcha: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      await this.sleep(this.retryDelayMs);
    }

    this.safeStatus(onStatus, `Da het ${this.maxRetries} lan thu.`);
    return false;
  }

  // ----------------------------------------------------------
  // Private: Detection
  // ----------------------------------------------------------

  private async detectCaptchaInContext(
    page: Page,
  ): Promise<CaptchaDetection> {
    // Check for captcha containers
    for (const selector of CAPTCHA_SELECTORS.captchaContainer) {
      const element = await page.$(selector);
      if (element) {
        const visible = await this.isVisible(element);
        if (visible) {
          const type = await this.identifyCaptchaType(page);
          return {
            detected: true,
            type,
            containerSelector: selector,
          };
        }
      }
    }

    // Check body text for captcha markers
    const bodyText = await page.evaluate(() =>
      (document.body?.innerText || '').toLowerCase(),
    );

    for (const marker of CAPTCHA_SELECTORS.captchaTextMarkers) {
      if (bodyText.includes(marker)) {
        const type = this.guessTypeFromText(bodyText);
        return {
          detected: true,
          type,
        };
      }
    }

    return { detected: false };
  }

  private async detectCaptchaInFrame(
    frame: Frame,
  ): Promise<CaptchaDetection> {
    try {
      for (const selector of CAPTCHA_SELECTORS.captchaContainer) {
        const element = await frame.$(selector);
        if (element) {
          return {
            detected: true,
            type: await this.identifyCaptchaTypeInFrame(frame),
            frame,
            containerSelector: selector,
          };
        }
      }
    } catch {
      // frame detached
    }

    return { detected: false };
  }

  private async identifyCaptchaType(
    page: Page,
  ): Promise<CaptchaType> {
    // Check slider
    for (const selector of CAPTCHA_SELECTORS.sliderTrack) {
      if (await page.$(selector)) return 'TiktokSliderWebTask';
    }

    // Check rotate
    for (const selector of CAPTCHA_SELECTORS.rotateInner) {
      if (await page.$(selector)) return 'TiktokRotateWebTask';
    }

    // Fallback: check body text
    const bodyText = await page.evaluate(() =>
      (document.body?.innerText || '').toLowerCase(),
    );
    return this.guessTypeFromText(bodyText);
  }

  private async identifyCaptchaTypeInFrame(
    frame: Frame,
  ): Promise<CaptchaType> {
    try {
      for (const selector of CAPTCHA_SELECTORS.sliderTrack) {
        if (await frame.$(selector)) return 'TiktokSliderWebTask';
      }
      for (const selector of CAPTCHA_SELECTORS.rotateInner) {
        if (await frame.$(selector)) return 'TiktokRotateWebTask';
      }
    } catch {
      // frame detached
    }
    return 'Tiktok3DSelectObjectWebTask';
  }

  private guessTypeFromText(text: string): CaptchaType {
    if (text.includes('slider') || text.includes('drag the puzzle') || text.includes('slide to')) {
      return 'TiktokSliderWebTask';
    }
    if (text.includes('rotate')) {
      return 'TiktokRotateWebTask';
    }
    if (text.includes('select') || text.includes('same object') || text.includes('same shape')) {
      return 'Tiktok3DSelectObjectWebTask';
    }
    return 'Tiktok3DSelectObjectWebTask';
  }

  // ----------------------------------------------------------
  // Private: Solving
  // ----------------------------------------------------------

  private async solveCaptcha(
    page: Page,
    detection: CaptchaDetection,
    onStatus?: StatusCallback,
  ): Promise<boolean> {
    const context = detection.frame || page;

    switch (detection.type) {
      case 'TiktokSliderWebTask':
        return this.solveSlider(page, context, onStatus);
      case 'TiktokRotateWebTask':
        return this.solveRotate(page, context, onStatus);
      case 'TiktokSelectObjectWebTask':
        return this.solveSelectObject(page, context, onStatus);
      case 'Tiktok3DSelectObjectWebTask':
      default:
        return this.solve3DSelect(page, context, onStatus);
    }
  }

  /**
   * Giải Slider captcha
   */
  private async solveSlider(
    page: Page,
    context: Page | Frame,
    onStatus?: StatusCallback,
  ): Promise<boolean> {
    this.safeStatus(onStatus, 'Dang giai Slider captcha...');

    // Find captcha image
    const imageBase64 = await this.getCaptchaImageBase64(context);
    if (!imageBase64) {
      this.safeStatus(onStatus, 'Khong tim thay hinh anh captcha.');
      return false;
    }

    // Get image display width
    const widthView = await this.getCaptchaImageWidth(context);

    const result = await this.omoClient.solveSlider(imageBase64, widthView, onStatus);
    if (!result) return false;

    // Tìm slider button và kéo
    const sliderButton = await this.findFirst(context, CAPTCHA_SELECTORS.sliderTrack);
    if (!sliderButton) {
      this.safeStatus(onStatus, 'Khong tim thay slider button.');
      return false;
    }

    const box = await sliderButton.boundingBox();
    if (!box) return false;

    // Kéo slider
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    const targetX = startX + result.end.x;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    // Kéo từ từ để giống người dùng thật
    const steps = 20;
    for (let i = 1; i <= steps; i++) {
      const progress = i / steps;
      const currentX = startX + (targetX - startX) * progress;
      const jitter = (Math.random() - 0.5) * 2;
      await page.mouse.move(currentX, startY + jitter);
      await this.sleep(10 + Math.random() * 20);
    }
    await page.mouse.up();

    return true;
  }

  /**
   * Giải Rotate captcha
   */
  private async solveRotate(
    page: Page,
    context: Page | Frame,
    onStatus?: StatusCallback,
  ): Promise<boolean> {
    this.safeStatus(onStatus, 'Dang giai Rotate captcha...');

    // Get inner + outer images
    const innerImg = await this.findFirst(context, CAPTCHA_SELECTORS.rotateInner);
    const outerImg = await this.findFirst(context, CAPTCHA_SELECTORS.rotateOuter);

    if (!innerImg || !outerImg) {
      this.safeStatus(onStatus, 'Khong tim thay hinh rotate captcha.');
      return false;
    }

    const innerBase64 = await this.elementToBase64(innerImg);
    const outerBase64 = await this.elementToBase64(outerImg);

    if (!innerBase64 || !outerBase64) {
      this.safeStatus(onStatus, 'Khong chuyen duoc anh rotate sang base64.');
      return false;
    }

    const result = await this.omoClient.solveRotate(innerBase64, outerBase64, onStatus);
    if (!result) return false;

    // Tìm slider track cho rotate
    const sliderButton = await this.findFirst(context, CAPTCHA_SELECTORS.sliderTrack);
    if (!sliderButton) {
      this.safeStatus(onStatus, 'Khong tim thay slider button cua rotate.');
      return false;
    }

    // Tính vị trí kéo dựa trên tỷ lệ rotate
    const box = await sliderButton.boundingBox();
    if (!box) return false;

    const trackBox = await sliderButton.evaluate((el) => {
      const parent = el.parentElement;
      if (!parent) return null;
      const rect = parent.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
    if (!trackBox) return false;

    const maxTranslateX = trackBox.width - box.width;
    const targetX = maxTranslateX * (1 - result.rotate);

    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    const endX = trackBox.x + targetX + box.width / 2;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    const steps = 25;
    for (let i = 1; i <= steps; i++) {
      const progress = i / steps;
      const currentX = startX + (endX - startX) * progress;
      const jitter = (Math.random() - 0.5) * 2;
      await page.mouse.move(currentX, startY + jitter);
      await this.sleep(10 + Math.random() * 20);
    }
    await page.mouse.up();

    return true;
  }

  /**
   * Giải 3D Select Object captcha
   */
  private async solve3DSelect(
    page: Page,
    context: Page | Frame,
    onStatus?: StatusCallback,
  ): Promise<boolean> {
    this.safeStatus(onStatus, 'Dang giai 3D Select Object captcha...');

    const imageBase64 = await this.getCaptchaImageBase64(context);
    if (!imageBase64) {
      this.safeStatus(onStatus, 'Khong tim thay hinh anh captcha.');
      return false;
    }

    const widthView = await this.getCaptchaImageWidth(context);
    const heightView = await this.getCaptchaImageHeight(context);

    this.safeStatus(onStatus, `Captcha image: ${widthView}x${heightView}, gui OMO API...`);

    const result = await this.omoClient.solve3DSelectObject(
      imageBase64,
      widthView,
      heightView,
      onStatus,
    );
    if (!result) return false;

    // Click vào 2 điểm
    const imageEl = await this.findCaptchaImage(context);
    if (!imageEl) {
      this.safeStatus(onStatus, 'Khong tim thay image element de click.');
      return false;
    }

    const imageBox = await imageEl.boundingBox();
    if (!imageBox) {
      this.safeStatus(onStatus, 'Khong lay duoc bounding box cua image.');
      return false;
    }

    // Click point A
    const clickAX = imageBox.x + result.pointA.x;
    const clickAY = imageBox.y + result.pointA.y;
    this.safeStatus(onStatus, `Click point A: (${Math.round(clickAX)}, ${Math.round(clickAY)})`);
    await page.mouse.click(clickAX, clickAY, { delay: 100 + Math.random() * 200 });
    await this.sleep(500 + Math.random() * 500);

    // Click point B
    const clickBX = imageBox.x + result.pointB.x;
    const clickBY = imageBox.y + result.pointB.y;
    this.safeStatus(onStatus, `Click point B: (${Math.round(clickBX)}, ${Math.round(clickBY)})`);
    await page.mouse.click(clickBX, clickBY, { delay: 100 + Math.random() * 200 });
    await this.sleep(500 + Math.random() * 300);

    // Click nút "Confirm" trong captcha modal
    this.safeStatus(onStatus, 'Tim va click nut Confirm...');
    try {
      for (const selector of CAPTCHA_SELECTORS.captchaSubmit) {
        const confirmBtn = await page.$(selector);
        if (confirmBtn) {
          const visible = await this.isVisible(confirmBtn);
          if (visible) {
            await confirmBtn.click({ force: true });
            this.safeStatus(onStatus, 'Da click Confirm.');
            break;
          }
        }
      }
    } catch (err) {
      this.safeStatus(onStatus, `Loi khi click Confirm: ${err instanceof Error ? err.message : String(err)}`);
    }

    return true;
  }

  /**
   * Giải Select Object captcha
   */
  private async solveSelectObject(
    _page: Page,
    context: Page | Frame,
    onStatus?: StatusCallback,
  ): Promise<boolean> {
    this.safeStatus(onStatus, 'Dang giai Select Object captcha...');

    const imageBase64 = await this.getCaptchaImageBase64(context);
    if (!imageBase64) {
      this.safeStatus(onStatus, 'Khong tim thay hinh anh captcha.');
      return false;
    }

    // Get question text
    const question = await context.evaluate(() => {
      const textEl =
        document.querySelector('.captcha-verify-text') ||
        document.querySelector('[class*="captcha"][class*="text"]') ||
        document.querySelector('.verify-captcha-text');
      return textEl?.textContent || '';
    });

    const result = await this.omoClient.solveSelectObject(imageBase64, question, onStatus);
    if (!result || !result.objects.length) return false;

    // Click các ô theo index
    // (chưa implement chi tiết vì phụ thuộc vào layout cụ thể)
    this.safeStatus(onStatus, `OMO tra ve ${result.objects.length} vi tri: [${result.objects.join(',')}]`);

    return true;
  }

  // ----------------------------------------------------------
  // Helpers
  // ----------------------------------------------------------

  private async findFirst(
    context: Page | Frame,
    selectors: string[],
  ): Promise<ElementHandle | null> {
    for (const selector of selectors) {
      const element = await context.$(selector);
      if (element) return element;
    }
    return null;
  }

  private async findCaptchaImage(
    context: Page | Frame,
  ): Promise<ElementHandle | null> {
    return this.findFirst(context, [
      ...CAPTCHA_SELECTORS.captchaImage,
      ...CAPTCHA_SELECTORS.selectObjectImage,
      ...CAPTCHA_SELECTORS.select3DImage,
    ]);
  }

  private async getCaptchaImageBase64(
    context: Page | Frame,
  ): Promise<string | null> {
    const imageEl = await this.findCaptchaImage(context);
    if (!imageEl) return null;

    return this.elementToBase64(imageEl);
  }

  private async elementToBase64(
    element: ElementHandle,
  ): Promise<string | null> {
    try {
      // Try getting src attribute
      const src = await element.getAttribute('src');

      if (src?.startsWith('data:image')) {
        // Already base64
        const commaIndex = src.indexOf(',');
        return commaIndex >= 0 ? src.slice(commaIndex + 1) : src;
      }

      if (src) {
        // Download image and convert
        const response = await element.evaluate(async (img) => {
          const imgEl = img as HTMLImageElement;
          const canvas = document.createElement('canvas');
          canvas.width = imgEl.naturalWidth || imgEl.width;
          canvas.height = imgEl.naturalHeight || imgEl.height;
          const ctx = canvas.getContext('2d');
          if (!ctx) return null;
          ctx.drawImage(imgEl, 0, 0);
          return canvas.toDataURL('image/png').split(',')[1];
        });

        return response || null;
      }

      // Screenshot as fallback
      const screenshot = await element.screenshot({ type: 'png' });
      return screenshot.toString('base64');
    } catch {
      return null;
    }
  }

  private async getCaptchaImageWidth(context: Page | Frame): Promise<number> {
    const imageEl = await this.findCaptchaImage(context);
    if (!imageEl) return 340; // default

    const box = await imageEl.boundingBox();
    return box?.width || 340;
  }

  private async getCaptchaImageHeight(context: Page | Frame): Promise<number> {
    const imageEl = await this.findCaptchaImage(context);
    if (!imageEl) return 212; // default

    const box = await imageEl.boundingBox();
    return box?.height || 212;
  }

  private async isVisible(element: ElementHandle): Promise<boolean> {
    try {
      return await element.evaluate((el) => {
        const htmlEl = el as HTMLElement;
        const style = window.getComputedStyle(htmlEl);
        const rect = htmlEl.getBoundingClientRect();
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          rect.width > 0 &&
          rect.height > 0
        );
      });
    } catch {
      return false;
    }
  }

  private safeStatus(onStatus: StatusCallback | undefined, message: string): void {
    if (!message) return;
    try {
      onStatus?.(message);
    } catch {
      // ignore
    }
    console.log(`[captcha-handler] ${message}`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
