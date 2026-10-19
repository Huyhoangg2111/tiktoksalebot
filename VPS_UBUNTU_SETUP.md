# TikTok Sales Bot - Huong Dan Cai Dat Tren VPS Ubuntu Moi

Tai lieu nay huong dan tu dau cho mot VPS Ubuntu trang moi tao, bo qua phan mua/tao VPS. Muc tieu la sau khi lam xong, bot Telegram se chay trong Docker tren VPS.

## 1. Tong quan

Mo hinh chay hien tai:

- Bot Telegram chay trong container Docker
- SQLite cua bot duoc luu o thu muc `runtime/`
- Chi can chay 1 lenh cai dat: `bash install-vps.sh`

Khong can:

- cai Node.js tren VPS
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

Luu y:

- Khong dat `TIKTOK_READ_ACCESS_TOKEN` va `TIKTOK_WRITE_ACCESS_TOKEN` trong `.env`
- Hai token nay duoc doc tu Google Sheet tab `Token` (hoac nhap truc tiep trong dashboard)

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
OTHER_MKT_CODE=...

SPENDING_THRESHOLD=...
BALANCE_THRESHOLD=...
CPC_THRESHOLD=...
CPA_THRESHOLD=...
CONVERSION_THRESHOLD=...
CTR_THRESHOLD=...
SALES_REVENUE_THRESHOLD=...

DATABASE_PATH=./bot_data.db

DATA_RETENTION_DAYS=45
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
OTHER_MKT_CODE=...
```

Ghi chu:

- `DATA_RETENTION_DAYS` la tuy chon, mac dinh 45, cho phep 1-365. Bot tu don du lieu cu (lich canh bao, log thay doi/clone, audit log, OTP/session het han...) trong mot job hang ngay chay khoang 00:35 gio VN
- `OTHER_MKT_CODE` dung cho lenh `/bckhac` (bao cao doanh so ma MKT khac). Neu trong, bot lay cac ma MKT tren TKQC dashboard khac `TARGET_MKT_CODE`
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
DATABASE_PATH=/app/runtime/bot_data.db
ADMIN_WEB_PORT=8080
HTTP_TIMEOUT_MS=30000
HTTP_MAX_RETRIES=2
```

Nghia la:

- ban khong can buoc phai them cac bien nay vao `.env`
- `DATABASE_PATH` trong `.env` local se bi Docker override bang duong dan trong container

## 4. Kiem tra Google Sheet truoc khi deploy

Trong Google Sheet cau hinh, can co:

### Tab `Token`

Can co cac dong:

```text
TIKTOK_READ_ACCESS_TOKEN | <read_token>
TIKTOK_WRITE_ACCESS_TOKEN | <write_token>
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

Neu on, ban se thay log khoi dong bot va scheduler.

Sau do vao Telegram thu:

```text
/start
/balance
/campaigns
```

## 11. Du lieu duoc luu o dau

Sau khi deploy, cac file quan trong duoc giu lai tai:

- `runtime/bot_data.db`

Y nghia:

- `bot_data.db`: du lieu SQLite cua bot

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

### Loi: duplicate qua official TikTok API khong chay

Nguyen nhan thuong gap:

- thieu `TIKTOK_WRITE_ACCESS_TOKEN` hoac token ghi het han/sai quyen
- campaign ID khong thuoc Business Center dang cau hinh
- campaign hoac material khong dung trang thai de nhan ban

Xu ly:

- kiem tra lai token ghi trong Google Sheet tab `Token` (hoac dashboard)
- kiem tra campaign ID dung chinh xac va gan voi Business Center dung
- xem log bang `sudo docker compose logs -f`, luong duplicate se dung o loi dau tien va bao lai cac id da tao duoc

## 14. Ghi chu van hanh

- Bot nay khong can mo cong web public de Telegram goi webhook
- Bot dang chay theo polling, chi can VPS co internet outbound
- Sau khi VPS reboot, container se tu len lai theo `restart: unless-stopped`
- Moi ngay khoang 00:35 gio VN, bot tu don du lieu cu hon `DATA_RETENTION_DAYS` ngay (mac dinh 45 ngay)

## 15. Checklist nhanh

1. Co source code tren VPS
2. Co `.env` dung
3. Google Sheet da share cho service account
4. Tab `Token` co `TIKTOK_READ_ACCESS_TOKEN`
5. Tab `Token` co `TIKTOK_WRITE_ACCESS_TOKEN`
6. Chay `bash install-vps.sh`
7. Xem `sudo docker compose logs -f`
8. Thu lenh Telegram `/start`

Neu ban lam dung 8 buoc tren, bot se co the chay tren VPS Ubuntu moi tao ma khong can giao dien desktop.
