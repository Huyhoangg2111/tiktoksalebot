# TikTok Sales Bot - Huong Dan Cai Dat Tren VPS Ubuntu Moi

Tai lieu nay huong dan tu dau cho mot VPS Ubuntu trang moi tao, bo qua phan mua/tao VPS. Muc tieu la sau khi lam xong, bot Telegram va signer headless se chay cung nhau trong Docker tren VPS.

## 1. Tong quan

Mo hinh chay hien tai:

- Bot Telegram chay trong container Docker
- Playwright signer chay headless cung container
- SQLite va session signer duoc luu o thu muc `runtime/`
- Chi can chay 1 lenh cai dat: `bash install-vps.sh`

Khong can:

- cai Node.js tren VPS
- cai Chromium thu cong
- mo giao dien desktop
- mo port public cho bot

## 2. Nhung thu can chuan bi truoc

Can chuan bi san tren may local:

- ma nguon repo nay
- file `.env`
- IP VPS
- tai khoan SSH vao VPS

Can chuan bi san tren he thong ngoai:

- Telegram bot token
- `ADMIN_CHAT_ID`
- Google Sheet cau hinh da share cho service account
- Google Service Account email + private key
- TikTok token trong Google Sheet tab `Token`
- `ACCOUNT_BOT` trong Google Sheet tab `Token`

Luu y:

- Khong dat `TIKTOK_READ_ACCESS_TOKEN` va `TIKTOK_WRITE_ACCESS_TOKEN` trong `.env`
- Hai token nay duoc doc tu Google Sheet tab `Token`
- `ACCOUNT_BOT` trong Google Sheet phai dung format:

```text
email|password|totp_secret
```

## 3. Kiem tra noi dung `.env`

Phan nay can noi ro: file huong dan ban dau va `.env` hien tai cua repo khong giong nhau 100 phan tram. Ly do la:

- mot so bien dang co san trong `.env` nhung la bien cu hoac bien local
- mot so bien cho Docker/VPS duoc `docker-compose.yml` tu them vao khi chay
- mot so gia tri nhay cam van nam trong Google Sheet, khong nam trong `.env`

### 3.1. Cac bien dang co trong `.env` hien tai

`.env` hien tai cua repo dang theo nhom nhu sau:

```env
TELEGRAM_BOT_TOKEN=...
ADMIN_CHAT_ID=...

TIKTOK_APP_ID=...
TIKTOK_APP_SECRET=...

CONFIG_GOOGLE_SHEET_ID=...
GOOGLE_SERVICE_ACCOUNT_EMAIL=...
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
TARGET_MKT_CODE=...

SPENDING_THRESHOLD=...
BALANCE_THRESHOLD=...
CPC_THRESHOLD=...
CPA_THRESHOLD=...
CONVERSION_THRESHOLD=...
CTR_THRESHOLD=...
SALES_REVENUE_THRESHOLD=...

DATABASE_PATH=./bot_data.db

PW_SIGNER_PORT=8092
PW_SIGNER_HEADLESS=true
PW_SIGNER_ENTRY_URL=https://ads.tiktok.com/i18n/manage/campaign
PW_SIGNER_STATE_PATH=artifacts/playwright-signer/session.json

OMO_CAPTCHA_API_KEY=...
```

### 3.2. Bien can tap trung kiem tra truoc khi deploy

Khi deploy len VPS, nhung bien quan trong nhat can dung la:

```env
TELEGRAM_BOT_TOKEN=...
ADMIN_CHAT_ID=...
CONFIG_GOOGLE_SHEET_ID=...
GOOGLE_SERVICE_ACCOUNT_EMAIL=...
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
TARGET_MKT_CODE=...
PW_SIGNER_HEADLESS=true
PW_SIGNER_PORT=8092
PW_SIGNER_ENTRY_URL=https://ads.tiktok.com/i18n/manage/campaign
OMO_CAPTCHA_API_KEY=...
```

Ghi chu:

- `OMO_CAPTCHA_API_KEY` la khuyen nghi manh, khong phai luc nao cung bat buoc
- `PW_SIGNER_HEADLESS=true` la bat buoc thuc te cho VPS khong co giao dien
- `CONFIG_GOOGLE_SHEET_ID` la bien dang duoc code uu tien doc

### 3.3. Bien co trong `.env` nhung ban co the de nguyen

Nhung bien nay dang co trong `.env` hien tai, nhung khong phai diem chinh de deploy VPS:

- `TIKTOK_APP_ID`
- `TIKTOK_APP_SECRET`
- `SPENDING_THRESHOLD`
- `BALANCE_THRESHOLD`
- `CPC_THRESHOLD`
- `CPA_THRESHOLD`
- `CONVERSION_THRESHOLD`
- `CTR_THRESHOLD`
- `SALES_REVENUE_THRESHOLD`

Ghi chu:

- Trong code hien tai, minh khong thay runtime chinh doc truc tiep `TIKTOK_APP_ID` va `TIKTOK_APP_SECRET`
- Nhom threshold o tren cung khong phai phan cau hinh chinh cho flow Docker/VPS hien tai
- Ban co the giu nguyen nhu file `.env` dang co, khong can xoa

### 3.4. Bien khong co trong `.env` nhung Docker tu them luc chay

Neu ban thac mac vi sao huong dan cu co nhac cac bien nay, do la vi `docker-compose.yml` dang tu inject luc runtime:

```env
PW_SIGNER_INTERNAL_ENABLED=true
PW_SIGNER_HOST=127.0.0.1
PW_SIGNER_AUTO_LOGIN_ON_STARTUP=true
PW_SIGNER_CHROMIUM_ARGS=--disable-dev-shm-usage,--no-zygote
DATABASE_PATH=/app/runtime/bot_data.db
PW_SIGNER_STATE_PATH=/app/runtime/playwright-signer/session.json
```

Nghia la:

- ban khong can buoc phai them cac bien nay vao `.env`
- `DATABASE_PATH` trong `.env` local se bi Docker override bang duong dan trong container
- `PW_SIGNER_STATE_PATH` trong `.env` local cung se bi Docker override bang duong dan trong `runtime/`

## 4. Kiem tra Google Sheet truoc khi deploy

Trong Google Sheet cau hinh, can co:

### Tab `Token`

Can co cac dong:

```text
TIKTOK_READ_ACCESS_TOKEN | <read_token>
TIKTOK_WRITE_ACCESS_TOKEN | <write_token>
ACCOUNT_BOT | email|password|totp_secret
```

### Tab `Permissions`

- Neu khong dat `TIKTOK_ADVERTISER_IDS` trong `.env`, thi phai co cac advertiser duoc bat trong sheet

### Tab `BC`

- Neu khong dat `TIKTOK_BC_ID` trong `.env`, thi BC!A2 phai co gia tri

## 5. SSH vao VPS

Tu may local:

```bash
ssh ubuntu@IP_VPS
```

Neu user cua VPS khong phai `ubuntu`, thay bang user dung cua ban.

## 6. Cai git tren VPS

Sau khi vao VPS:

```bash
sudo apt update
sudo apt install -y git
```

## 7. Dua source code len VPS

Neu code chua duoc up len GitHub, hay dung cach upload truc tiep tu may local len VPS. De tranh nham duong dan `~`, tai lieu nay khuyen nghi dung co dinh thu muc:

```bash
/opt/tiktoksalebot
```

Neu ban dang dang nhap bang `root`, thi:

- `~` = `/root`
- `cd ~/tiktoksalebot` chi dung khi repo thuc su nam trong `/root/tiktoksalebot`

### Cach 1: upload truc tiep tu may local len VPS

Tren may Windows PowerShell, chay:

```powershell
scp -r D:\tiktoksalebot root@IP_VPS:/opt/
scp D:\tiktoksalebot\.env root@IP_VPS:/opt/tiktoksalebot/.env
```

Neu ban dang SSH bang user `ubuntu` thay vi `root`, dung:

```powershell
scp -r D:\tiktoksalebot ubuntu@IP_VPS:/home/ubuntu/
scp D:\tiktoksalebot\.env ubuntu@IP_VPS:/home/ubuntu/tiktoksalebot/.env
```

Sau khi upload xong, vao VPS. Neu ban dang dung user `ubuntu`, chuyen source sang `/opt`:

```bash
sudo mkdir -p /opt
sudo rm -rf /opt/tiktoksalebot
sudo mv /home/ubuntu/tiktoksalebot /opt/tiktoksalebot
sudo chown -R $USER:$USER /opt/tiktoksalebot
```

Sau do:

```bash
cd /opt/tiktoksalebot
ls -la
```

Neu thay file `install-vps.sh`, `docker-compose.yml`, `Dockerfile`, `package.json` la dung thu muc.

Khi upload bang FileZilla hoac `scp`, khong can dua len VPS cac thu muc/file sau:

- `node_modules/`
- `dist/`
- `artifacts/`
- `runtime/`
- `scratch/`
- `.git/`
- `bot_data.db`

### Cach 2: clone tu git

```bash
sudo mkdir -p /opt/tiktoksalebot
sudo chown -R $USER:$USER /opt/tiktoksalebot
git clone <REPO_URL> /opt/tiktoksalebot
cd /opt/tiktoksalebot
```

Neu sau nay ban co repo Git, co the clone bang:

```bash
sudo mkdir -p /opt/tiktoksalebot
sudo chown -R $USER:$USER /opt/tiktoksalebot
git clone <REPO_URL> /opt/tiktoksalebot
cd /opt/tiktoksalebot
```

Neu ban khong chac source dang nam o dau, tim nhanh bang:

```bash
find / -maxdepth 3 -type d -name "tiktoksalebot" 2>/dev/null
```

## 8. Dua file `.env` len VPS

Neu ban dang dung Windows PowerShell tren may local:

```powershell
scp .env root@IP_VPS:/opt/tiktoksalebot/.env
```

Neu ban dang dung user `ubuntu` thay vi `root`, dung:

```powershell
scp .env ubuntu@IP_VPS:/opt/tiktoksalebot/.env
```

Neu repo da nam san tren VPS nhung chua co `.env`, day la buoc bat buoc.

Kiem tra lai tren VPS:

```bash
cd /opt/tiktoksalebot
ls -la
cat .env
```

Khuyen nghi: chi kiem tra nhanh file co ton tai va du cac bien, khong chia se `.env` cho nguoi khac.

## 9. Chay cai dat tu dong

Trong thu muc repo tren VPS, chay:

```bash
bash install-vps.sh
```

Script nay se tu dong:

- kiem tra Ubuntu/Debian
- kiem tra `.env`
- tao thu muc `runtime/`
- cai Docker neu may chua co
- cai Docker Compose plugin neu may chua co
- bat Docker service
- build image
- chay container nen

## 10. Kiem tra bot da len chua

Xem trang thai:

```bash
sudo docker compose ps
```

Xem log realtime:

```bash
sudo docker compose logs -f
```

Neu on, ban se thay log khoi dong bot, scheduler, va signer.

Sau do vao Telegram thu:

```text
/start
/balance
/campaigns
```

## 11. Du lieu duoc luu o dau

Sau khi deploy, cac file quan trong duoc giu lai tai:

- `runtime/bot_data.db`
- `runtime/playwright-signer/session.json`

Y nghia:

- `bot_data.db`: du lieu SQLite cua bot
- `session.json`: session login TikTok de restart VPS/container khong phai login lai tu dau

Khong nen xoa thu muc `runtime/` neu bot dang chay on dinh.

## 12. Lenh van hanh sau nay

Xem log:

```bash
sudo docker compose logs -f
```

Khoi dong lai:

```bash
sudo docker compose restart
```

Dung bot:

```bash
sudo docker compose down
```

Build lai sau khi sua code hoac `git pull`:

```bash
git pull
bash install-vps.sh
```

## 13. Cac loi thuong gap

### Loi: khong co `.env`

Nguyen nhan:

- chua upload file `.env`

Xu ly:

- copy lai `.env` len dung thu muc repo

### Loi: bot len nhung khong doc duoc Google Sheet

Nguyen nhan thuong gap:

- sai `CONFIG_GOOGLE_SHEET_ID` hoac `GOOGLE_SHEET_ID`
- sai `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- sai `GOOGLE_PRIVATE_KEY`
- Google Sheet chua share cho service account

Xu ly:

- kiem tra lai service account email
- share sheet cho dung email do
- dam bao private key giu nguyen format `\n`

### Loi: signer khong login duoc TikTok

Nguyen nhan thuong gap:

- `ACCOUNT_BOT` chua co trong tab `Token`
- format `ACCOUNT_BOT` sai
- TOTP secret sai
- TikTok yeu cau captcha va chua co `OMO_CAPTCHA_API_KEY`

Xu ly:

- kiem tra lai dong `ACCOUNT_BOT`
- kiem tra lai TOTP secret
- neu can captcha solver thi cau hinh `OMO_CAPTCHA_API_KEY`
- xem log bang `sudo docker compose logs -f`

### Loi: duplicate Smart+ khong chay

Nguyen nhan:

- signer chua dang nhap thanh cong
- session het han

Xu ly:

- xem log signer
- restart container
- neu can thi dang nhap lai thong qua `ACCOUNT_BOT`

## 14. Ghi chu van hanh

- Bot nay khong can mo cong web public de Telegram goi webhook
- Bot dang chay theo polling, chi can VPS co internet outbound
- Lan build dau tien co the mat vai phut vi Docker can tai Chromium qua Playwright
- Sau khi VPS reboot, container se tu len lai theo `restart: unless-stopped`

## 15. Checklist nhanh

1. Co source code tren VPS
2. Co `.env` dung
3. Google Sheet da share cho service account
4. Tab `Token` co `TIKTOK_READ_ACCESS_TOKEN`
5. Tab `Token` co `TIKTOK_WRITE_ACCESS_TOKEN`
6. Tab `Token` co `ACCOUNT_BOT`
7. Chay `bash install-vps.sh`
8. Xem `sudo docker compose logs -f`
9. Thu lenh Telegram `/start`

Neu ban lam dung 9 buoc tren, bot se co the chay tren VPS Ubuntu moi tao ma khong can giao dien desktop.
