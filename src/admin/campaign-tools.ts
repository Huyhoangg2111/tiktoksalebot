import type { IncomingMessage, ServerResponse } from 'node:http';
import { duplicateCampaign } from '../campaigns/manager.js';
import { countLoggedClones, recordCampaignClone } from '../campaigns/clone-tracking.js';
import { assertCopyQuantity, formatCopyLoop, runCopyLoop } from '../campaigns/duplicate-safety.js';
import {
  consumeConfirmation,
  createConfirmation,
  cancelConfirmation,
  peekConfirmation,
  type BidConfirmPayload,
  type BudgetConfirmPayload,
  type DeleteConfirmPayload,
  type DuplicateConfirmPayload,
  type ResumeConfirmPayload,
} from '../campaigns/confirmations.js';
import { deletePartialCampaign, previewDeletePartial, previewOfficialDuplicate } from '../campaigns/official-duplicate.js';
import { commitBidChange, commitBudgetChange, describeMoneyError, previewBidChange, previewBudgetChange } from '../campaigns/money-edit.js';
import { hashMoneyState, parseBudgetMode, parsePositiveMoney, type BudgetMode } from '../tiktok/smartplus/money.js';

const ACTOR = 'dashboard';

const PAGE = `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Campaign · TikTokSaleBot</title>
<style>
  body{margin:0;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#f4f7fb;color:#0f1b33}
  header{display:flex;justify-content:space-between;align-items:center;padding:16px 20px;background:#0f1b33;color:#fff}
  header a{color:#dbe7ff;font-size:14px}
  main{max-width:880px;margin:0 auto;padding:20px}
  form,section{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:16px;margin-bottom:16px}
  label{display:flex;flex-direction:column;gap:4px;font-size:13px;color:#475569}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
  input,select,button{font:inherit;padding:8px 10px;border-radius:8px;border:1px solid #cbd5e1}
  button{background:#2563eb;color:#fff;border:0;cursor:pointer}
  button.ghost{background:#e2e8f0;color:#0f1b33}
  pre{white-space:pre-wrap;background:#f8fafc;border-radius:8px;padding:12px;font-size:13px}
  .err{color:#a42222}
</style>
</head>
<body>
<header>
  <b>Nhân bản, ngân sách, giá thầu</b>
  <a href="/admin">Về dashboard</a>
</header>
<main>
  <form id="form">
    <div class="grid">
      <label>Thao tác
        <select name="action" id="action">
          <option value="duplicate">Nhân bản</option>
          <option value="budget">Đổi ngân sách</option>
          <option value="bid">Đổi giá thầu</option>
          <option value="resume">Tiếp tục bản dở</option>
          <option value="delete">Xóa bản Smart+ dở</option>
        </select>
      </label>
      <label>Campaign ID<input name="campaignId" required inputmode="numeric"></label>
      <label>Số lượng<input name="quantity" value="1" inputmode="numeric"></label>
      <label>Ngân sách<input name="budget" placeholder="để trống nếu giữ nguyên"></label>
      <label>Giá thầu<input name="bid" placeholder="để trống nếu giữ nguyên"></label>
      <label>Chế độ ngân sách
        <select name="mode">
          <option value="">Giữ nguyên</option>
          <option value="ngày">Ngày</option>
          <option value="trọn">Trọn đời</option>
          <option value="dynamic">Dynamic daily</option>
        </select>
      </label>
      <label>Campaign mới (resume)<input name="newCampaignId" placeholder="chỉ khi tiếp tục bản dở"></label>
      <label>Ad group ID (resume)<input name="adgroupId"></label>
    </div>
    <p><button type="submit">Xem trước</button></p>
    <p>Xem trước chỉ đọc dữ liệu. Campaign chỉ được tạo hoặc sửa sau khi bấm xác nhận.</p>
  </form>
  <section>
    <div id="out">Chưa có bản xem trước.</div>
  </section>
</main>
<script>
const out = document.getElementById('out');
function show(html){ out.innerHTML = html; }
document.getElementById('form').onsubmit = async (event) => {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(event.target).entries());
  show('Đang đọc TikTok...');
  const response = await fetch('/admin/api/campaigns/preview', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) { show('<p class="err">'+escapeHtml(data.error||'Lỗi')+'</p>'); return; }
  const typed = data.requireTypedId ? '<p><label>Gõ lại campaign id<input id="confirmId" inputmode="numeric" autocomplete="off"></label></p>' : '';
  const confirm = data.canConfirm ? typed + '<p><button type="button" id="go">Xác nhận ghi lên TikTok</button> <button type="button" class="ghost" id="stop">Hủy</button></p>' : '<p class="err">Chưa thể xác nhận.</p>';
  show('<pre>'+escapeHtml(data.summary||'')+'</pre>'+confirm);
  const go = document.getElementById('go');
  const stop = document.getElementById('stop');
  if (go) go.onclick = async () => {
    go.disabled = true;
    const confirmId = (document.getElementById('confirmId') || {}).value || '';
    const done = await fetch('/admin/api/campaigns/confirm', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ token: data.token, confirmId }) });
    const payload = await done.json();
    show('<pre>'+escapeHtml(payload.summary || payload.error || JSON.stringify(payload))+'</pre>');
  };
  if (stop) stop.onclick = async () => {
    await fetch('/admin/api/campaigns/cancel', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ token: data.token }) });
    show('Đã hủy. Không có gì được ghi lên TikTok.');
  };
};
function escapeHtml(value){ return String(value).replace(/[&<>]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[ch])); }
</script>
</body>
</html>`;

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 100_000) throw new Error('Dữ liệu quá lớn');
  }
  const value = raw ? JSON.parse(raw) : {};
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function optionalMoney(value: unknown, label: string): number | undefined {
  const text = String(value ?? '').trim();
  if (!text || text === '-') return undefined;
  return parsePositiveMoney(text, label);
}

export async function handleCampaignAdmin(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname === '/admin/campaigns' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
    return true;
  }
  if (url.pathname === '/admin/api/campaigns/preview' && req.method === 'POST') {
    try {
      const body = await readJson(req);
      const action = String(body.action || 'duplicate');
      const campaignId = String(body.campaignId || '').trim();
      if (!/^\d+$/.test(campaignId)) throw new Error('Campaign ID phải là chuỗi số.');
      if (action === 'duplicate') {
        const quantity = assertCopyQuantity(parseInt(String(body.quantity || '1'), 10), await countLoggedClones());
        const budget = optionalMoney(body.budget, 'Ngân sách');
        const bid = optionalMoney(body.bid, 'Giá thầu');
        const preview = await previewOfficialDuplicate(campaignId, { overrideBudget: budget, overrideBid: bid, actor: ACTOR });
        const summary = [preview.summary, '', `Cách làm: ${preview.method}`, `Số lượng: ${quantity}`, ...preview.warnings, ...preview.blockers].join('\n');
        const token = preview.canConfirm
          ? createConfirmation({ kind: 'duplicate', actor: ACTOR, summary, payload: { campaignId, quantity, budget, bid, campaignName: preview.campaignName } })
          : undefined;
        sendJson(res, 200, { summary, canConfirm: preview.canConfirm, token });
        return true;
      }
      if (action === 'budget') {
        const budget = parsePositiveMoney(body.budget, 'Ngân sách');
        const mode = parseBudgetMode(String(body.mode || '')) as BudgetMode | undefined;
        const { snapshot, plan } = await previewBudgetChange(campaignId, budget, mode);
        const summary = [plan.before, '', plan.after, ...plan.writes.map(write => `${write.endpoint}: ${write.summary}`), ...plan.limitations].join('\n');
        const token = createConfirmation({
          kind: 'budget',
          actor: ACTOR,
          summary,
          payload: { campaignId, budget, mode, stateHash: hashMoneyState(snapshot, plan) },
        });
        sendJson(res, 200, { summary, canConfirm: true, token });
        return true;
      }
      if (action === 'bid') {
        const bid = parsePositiveMoney(body.bid, 'Giá thầu');
        const { snapshot, plan } = await previewBidChange(campaignId, bid);
        const summary = [plan.before, '', plan.after, ...plan.limitations].join('\n');
        const token = createConfirmation({
          kind: 'bid',
          actor: ACTOR,
          summary,
          payload: { campaignId, bid, stateHash: hashMoneyState(snapshot, plan) },
        });
        sendJson(res, 200, { summary, canConfirm: true, token });
        return true;
      }
      if (action === 'resume') {
        const newCampaignId = String(body.newCampaignId || '').trim();
        const adgroupId = String(body.adgroupId || '').trim() || undefined;
        if (!/^\d+$/.test(newCampaignId)) throw new Error('Cần campaign id của bản dở.');
        const preview = await previewOfficialDuplicate(campaignId, { resume: { campaignId: newCampaignId, adgroupId }, actor: ACTOR });
        const token = preview.canConfirm
          ? createConfirmation({
            kind: 'resume',
            actor: ACTOR,
            summary: preview.summary,
            payload: { sourceCampaignId: campaignId, newCampaignId, adgroupId },
          })
          : undefined;
        sendJson(res, 200, { summary: preview.summary, canConfirm: preview.canConfirm, token });
        return true;
      }
      if (action === 'delete') {
        const preview = await previewDeletePartial(campaignId);
        const token = preview.canConfirm
          ? createConfirmation({ kind: 'delete-partial', actor: ACTOR, summary: preview.summary, payload: { campaignId } })
          : undefined;
        sendJson(res, 200, { summary: preview.summary, canConfirm: preview.canConfirm, token, requireTypedId: preview.canConfirm });
        return true;
      }
      throw new Error('Thao tác không hợp lệ.');
    } catch (error) {
      sendJson(res, 400, { error: describeMoneyError(error) });
      return true;
    }
  }
  if (url.pathname === '/admin/api/campaigns/cancel' && req.method === 'POST') {
    const body = await readJson(req);
    cancelConfirmation(String(body.token || ''));
    sendJson(res, 200, { ok: true });
    return true;
  }
  if (url.pathname === '/admin/api/campaigns/confirm' && req.method === 'POST') {
    try {
      const body = await readJson(req);
      const token = String(body.token || '');
      const peeked = peekConfirmation(token);
      if (!peeked || peeked.actor !== ACTOR) {
        sendJson(res, 400, { error: 'Phiên xác nhận không còn hiệu lực.' });
        return true;
      }
      if (peeked.kind === 'delete-partial') {
        const typedId = String(body.confirmId || '').trim();
        const expectedId = (peeked.payload as DeleteConfirmPayload).campaignId;
        if (typedId !== expectedId) {
          sendJson(res, 400, { error: 'Gõ lại đúng campaign id để xóa. Phiên xác nhận vẫn còn.' });
          return true;
        }
      }
      const pending = consumeConfirmation(token);
      if (!pending || pending.actor !== ACTOR) {
        sendJson(res, 400, { error: 'Phiên xác nhận không còn hiệu lực.' });
        return true;
      }
      if (pending.kind === 'duplicate') {
        const payload = pending.payload as DuplicateConfirmPayload;
        const outcome = await runCopyLoop(payload.quantity, async () => {
          const result = await duplicateCampaign(payload.campaignId, {
            overrideBudget: payload.budget,
            overrideBid: payload.bid,
            actor: ACTOR,
          });
          try {
            await recordCampaignClone(payload.campaignId, result);
          } catch (recordError) {
            console.error('Không ghi được bộ đếm nhân bản campaign:', recordError);
          }
          return { campaignId: result.campaignId, campaignName: result.campaignName || payload.campaignName };
        });
        const summary = formatCopyLoop(outcome, payload.quantity);
        const kept = outcome.created.length > 0 || outcome.partialIds.length > 0;
        sendJson(res, kept ? 200 : 400, kept ? { summary, error: outcome.error } : { error: summary, summary });
        return true;
      }
      if (pending.kind === 'budget') {
        const payload = pending.payload as BudgetConfirmPayload;
        const plan = await commitBudgetChange(
          payload.campaignId,
          payload.budget,
          payload.mode ? parseBudgetMode(payload.mode) : undefined,
          ACTOR,
          payload.stateHash
        );
        sendJson(res, 200, { summary: plan.after });
        return true;
      }
      if (pending.kind === 'bid') {
        const payload = pending.payload as BidConfirmPayload;
        const plan = await commitBidChange(payload.campaignId, payload.bid, ACTOR, payload.stateHash);
        sendJson(res, 200, { summary: plan.after });
        return true;
      }
      if (pending.kind === 'resume') {
        const payload = pending.payload as ResumeConfirmPayload;
        const result = await duplicateCampaign(payload.sourceCampaignId, {
          resume: { campaignId: payload.newCampaignId, adgroupId: payload.adgroupId },
          actor: ACTOR,
        });
        try {
          await recordCampaignClone(payload.sourceCampaignId, result);
        } catch (recordError) {
          console.error('Không ghi được bộ đếm nhân bản campaign:', recordError);
        }
        sendJson(res, 200, { summary: `Đã tiếp tục ${result.campaignId}. Bản sao vẫn DISABLE.` });
        return true;
      }
      if (pending.kind === 'delete-partial') {
        const payload = pending.payload as DeleteConfirmPayload;
        await deletePartialCampaign(payload.campaignId, ACTOR);
        sendJson(res, 200, { summary: `Đã xóa ${payload.campaignId}.` });
        return true;
      }
      sendJson(res, 400, { error: 'Không nhận ra thao tác đã xác nhận.' });
      return true;
    } catch (error) {
      sendJson(res, 400, { error: describeMoneyError(error) });
      return true;
    }
  }
  return false;
}
