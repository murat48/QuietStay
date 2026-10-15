# QuietStay — Basımdan kiraya, adım adım

Bir haftanın basılıp kiraya verilmesi, baştan sona. Örnek değerler #22'nin gerçek
provasından alındı (prova kontratı `CBKA273D…`); kendi haftan için yalnızca işaretli
değerleri değiştir.

| Rol | Hesap (örnekte) | Ne yapar |
| --- | --- | --- |
| Sahip | `GC4COEPJQRXZFTRZJYOYEIHVX6OCSZD5GMOAI6JGRDM3Y33VKBLODYUE` | Gizli değeri üretir, basım ister, ilana çıkarır, kanıtla kiralar |
| İhraççı | `GBNBWXSCEGJWGMNZ2GAOFG2RBZOCTGTI6SIJH3ZSU2AEPZWCFUA7YUBE` | Haftayı basar, kaydı sahibe verir — kiraya onay **vermez** |
| Kiracı | `GBWVXYC22WTOCIRCH6CPK7GAUWDBWORSJ6XJPWXGFR3X3HY5OA67NDVC` | Kiralamak için talep eder |

Terminal komutları proje klasöründe çalışır: `~/QuietStay/QuietStay`.
Uygulama: `http://localhost:3000` (önce `npm run start`).

---

## A. Basım

### 1. Sahip — gizli değeri üret · terminal

```bash
npm run zk:secret -- .secrets/hafta-2026-11-15-owner.json
```

- Dosya adını sen seçersin; her hafta için **yeni** bir ad ver (var olan dosyanın
  üzerine yazmaz). Ad sadece etiket — haftanın tarihleri formdan gelir.
- Çıktı:
  ```
  ✓ wrote .secrets/hafta-2026-11-15-owner.json — keep it private
    h (shareable): 1234…
    ask the issuer: http://localhost:3000/issue?h=1234…
  ```
- **Bu dosyayı sakla.** Kaybedersen hafta bir daha kiralanamaz ve satılamaz.
  Kimseye verme; paylaşılan tek şey `h`.

### 2. Sahip — basım talebi gönder · tarayıcı

1. Çıktıdaki `ask the issuer:` linkine **Ctrl+tıkla**.
2. Freighter'da **sahip** hesabını seç, uygulamada **Connect wallet**.
3. "Your h" kutusu dolu gelir → **Request issuance**.

### 3. İhraççı — haftayı bas · tarayıcı

1. Uygulamada bağlantıyı kes; Freighter'da **ihraççı** hesabına geç, yeniden bağlan.
2. **Issue** ekranı → "Requests from owners" → talepte **Issue to this account**.
   Sahibin hesabı ve `h` dolar, kilitlenir.
3. Formu doldur (isim, tesis, **Check in / Check out**, tapu, aidat) → **Issue on testnet**.

### 4. İhraççı — kaydı indir · tarayıcı

- Ekranda **Right #N** çıkar (örnekte #22). **Hemen** **Save record for right #N**.
- Dosya: `C:\Users\Murat\Downloads\right-22.record.json`
  (WSL'de: `/mnt/c/Users/Murat/Downloads/right-22.record.json`).
- **Bu dosya başka hiçbir yerde saklanmaz.** Sekme kapanmadan indir ve sahibe ver.

---

## B. Kira

### 5. Sahip — ilana çıkar · tarayıcı

Sahip hesabıyla **List** ekranı → haftayı kiralık yayınla → Freighter'da imzala.
Zincirde `list(…, 22, 518400)` görünür: 518400 saniye = 6 günlük kira ilanı.

### 6. Kiracı — talep et · tarayıcı

Kiracı kendi hesabıyla **List** ekranında haftayı bulur, kiralamak için talep gönderir.

### 7. Sahip — kanıtı üret · terminal

Sahip hesabıyla **List** ekranında talebin altında hazır komut görünür. Ondaki
`<your record>.json` ve `<your secret>.json` yerine kendi dosyalarını yaz:

```bash
npm run zk:prove -- \
  --record /mnt/c/Users/Murat/Downloads/right-22.record.json \
  --secret .secrets/hafta-2026-11-15-owner.json \
  --right 22 \
  --from GC4COEPJQRXZFTRZJYOYEIHVX6OCSZD5GMOAI6JGRDM3Y33VKBLODYUE \
  --to GBWVXYC22WTOCIRCH6CPK7GAUWDBWORSJ6XJPWXGFR3X3HY5OA67NDVC \
  --rental-until 1793491200 \
  --out proofs/right-22
```

| Parametre | Ne | Nereden |
| --- | --- | --- |
| `--record` | 4. adımda indirilen kayıt | İndirilenler |
| `--secret` | 1. adımda üretilen gizli dosya | `.secrets/` |
| `--right` | Haftanın numarası | Basım ekranı / List ekranı |
| `--from` | Sahibin hesabı | List ekranındaki komut |
| `--to` | Talebi gönderen kiracı | List ekranındaki komut |
| `--rental-until` | Kiranın bittiği an, Unix saniye = haftanın check-out'u | List ekranındaki komut |
| `--out` | Kanıtın yazılacağı klasör | Serbest |

- `<` ve `>` işaretlerini sil; dosya yollarını `.json` uzantısıyla yaz.
- `--rental-until` sayısını kendin bulmak için: `date -u -d 2026-11-01 +%s` → `1793491200`.
  Tersi: `date -u -d @1793491200`.
- Başarılı çıktı:
  ```
  ✓ snarkjs groth16 verify: OK
  ✓ wrote …/proofs/right-22/proof.json, public.json, transfer.json
  ```

### 8. Sahip — kanıt dosyasını İndirilenler'e kopyala · terminal

```bash
cp proofs/right-22/transfer.json /mnt/c/Users/Murat/Downloads/right-22.transfer.json
```

Windows tarayıcısı WSL klasörlerini zor açtığı için.

### 9. Sahip — kirayı gönder · tarayıcı

1. Sahip hesabıyla **Transfer** ekranı (QuietStay'de — Freighter'da değil).
2. **Prove ownership** → `right-22.transfer.json` dosyasını seç.
3. Freighter imza ister → onayla.

**Süre:** kanıt ~360 ledger (yaklaşık yarım saat) geçerli. Geçerse 7. adımı tekrar çalıştır.

### 10. Kontrol · tarayıcı, cüzdansız

**Verify** ekranında haftayı aç: kira, "Verified on chain" listesinde işlem bağlantısıyla
görünür. Zincirde `holdings`: sahip (süresiz) + kiracı (`expires_at 1793491200`).
Süre dolunca hafta, işlem gerekmeden sahibine döner.

---

## Hatırla

- **İhraççı kiraya onay vermez.** Onay, sahibin kanıtı ve imzasıdır (7–9. adımlar).
- **Saklanacak iki dosya:** gizli dosya (`.secrets/…owner.json`) ve kayıt
  (`right-N.record.json`). İkisi birlikte olmadan hafta devredilemez.
- **Hangi kontrat:** prova `CBKA273D…`; video ve teslim **final** `CCSQRSLC…`.
  Final'e dönmek için: `cp .env.final.local .env.local && npm run build && npm run start`.
- **Sık hatalar:**
  - `ENOENT … right-N.record.json` → kayıt indirilmemiş ya da `N` değiştirilmemiş.
  - `exists; refusing to overwrite` → `zk:secret` için yeni bir dosya adı ver.
  - Sayfa açılmıyor → sunucu durmuş/duraklatılmış; `npm run start` (Ctrl+Z değil, Ctrl+C ile kapat).
