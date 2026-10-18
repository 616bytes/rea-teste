<div align="center">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md)
· [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md) · **Azərbaycanca**

# REA: Hər şeyi tərs mühəndislikdən keçirin

### Binar fayllar, tətbiqlər və icra zamanı davranışı üzrə tərs mühəndislik üçün vahid MCP.

**Bəyəndiyiniz bir funksiya gördünüz? Onun necə işlədiyini binar səviyyəyə qədər anlayın.**

[![npm version](https://img.shields.io/npm/v/rea-agents?style=flat-square&color=cb3837)](https://www.npmjs.com/package/rea-agents)
[![MCP tool catalog](https://img.shields.io/badge/MCP-tool_catalog-5c4ee5?style=flat-square)](../mcp-contracts.md#generated-catalog)
[![Node.js requirements](https://img.shields.io/badge/Node.js-requirements-339933?style=flat-square&logo=nodedotjs&logoColor=white)](#nələri-analiz-edə-bilərsiniz)
[![skills.sh](https://skills.sh/b/morluto/rea?style=flat-square)](https://skills.sh/morluto/rea/reverse-engineer-anything)
[![MIT license](https://img.shields.io/badge/license-MIT-f4c430?style=flat-square)](../../LICENSE)
[![Discord](https://img.shields.io/discord/1556595354999332884?logo=discord&logoColor=white&label=Discord&color=5865F2)](https://discord.gg/GkcryMnJDM)

<a href="https://trendshift.io/repositories/82054?utm_source=repository-badge&amp;utm_medium=badge&amp;utm_campaign=badge-repository-82054" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/repositories/82054" alt="morluto%2Frea | Trendshift" width="250" height="55"/></a>

**[Vebsayt](https://rea.tools/) · [Bələdçilər](https://rea.tools/guides/) · [Nümunələr](https://rea.tools/showcase/)**

[Sürətli başlanğıc](#sürətli-başlanğıc) · [REA necə işləyir](#rea-necə-işləyir) · [Nələri analiz edə bilərsiniz](#nələri-analiz-edə-bilərsiniz) · [Nümunələr](#nümunələr) · [Tez-tez verilən suallar](#tez-tez-verilən-suallar) · [Sənədlər](#sənədlər)

<code>npx rea-agents setup</code>

</div>

> [!IMPORTANT]
> REA-nı [morluto/rea](https://github.com/morluto/rea),
> [rea.tools](https://rea.tools/) və ya [rea-agents npm paketi](https://www.npmjs.com/package/rea-agents) vasitəsilə əldə edin.
> Quraşdırma və buraxılış keçidlərini bu rəsmi mənbələrdən izləyin. Oxşar
> repozitoriya adı və ya kopyalanmış README yüklənən faylın rəsmi olduğunu sübut etmir.

<div align="center">

<br />

<img src="../assets/rea-hopper-analysis.png" alt="REA yerli binar faylı araşdırarkən Hopper daxilində analiz körpüsünü işə salır" width="1200" />

<br /><br />

<table aria-label="REA icması">
<tr>
<td align="center" width="360">
  <a href="https://discord.gg/GkcryMnJDM">
    <img src="../assets/discord.svg" height="42" alt="Discord" /><br />
    <strong>Tərs mühəndislik icmasına qoşulun</strong>
  </a><br />
  <sub>Discord · Sual-cavab · Nəticələrinizi paylaşın</sub>
</td>
</tr>
</table>

<br />

</div>

---

Bir tətbiqdə öz məhsulunuzda görmək istədiyiniz funksiya gördünüz? Agentinizdən onu REA ilə araşdırmasını istəyin. Agent tətbiqi mənbə kodu olmadan araşdıra, funksiyanın necə işlədiyini izah edə, sübutları göstərə və layihəniz üçün onun bir versiyasını qura bilər.

REA agentinizi yerli binar faylları, JavaScript və Electron tətbiqlərini, .NET assembly-lərini və vebsaytları araşdıran alətlərə qoşur. Eyni alətlərdən terminalınızdan da istifadə edə bilərsiniz. Analiz lokal olaraq işləyir və nəticələr hər bir nəticənin arxasındakı sübutları və məhdudiyyətləri ehtiva edir.

Quraşdırma REA-nı agentinizdə qeydiyyatdan keçirir və uyğun iş axını təlimatlarını quraşdırır. Yerli kod analizi mövcud Hopper, Ghidra və ya IDA quraşdırmasından istifadə edə bilər; quraşdırma, istəyə bağlı olaraq, təsdiqinizlə Hopper-i də quraşdıra bilər. Statik JavaScript analizi üçün heç bir yerli analiz mühərriki lazım deyil.

> Quraşdırma təlimatları, illüstrasiyalı bələdçilər və real nümunə araşdırmaları üçün **[REA vebsaytına daxil olun](https://rea.tools/)**.

## Sürətli başlanğıc

Linux-da Ghidra, JADX, firmware alətlərinin işə salınması və statik JavaScript/Electron
analizi prosesə sahiblik yoxlamaları üçün REA-nın `PATH`-ında procps ilə uyğun `ps`
tələb edir. Bərpa addımları `docs/installation.md` faylında
"Linux owned-process prerequisite" bölməsindədir.

### Agentinizi qurun

Node.js və npm quraşdırılmış halda bu əmri işlədin:

```bash
npx rea-agents setup
```

Agentlərinizi seçin, təklif olunan dəyişikliklərə baxın və onları təsdiqləyin. Quraşdırma
mövcud konfiqurasiyanın ehtiyat nüsxələrini yaradaraq REA-nın MCP serverini və uyğun iş axını
təlimatlarını əlavə edir. Sonra agentinizi yenidən başladın.

Quraşdırma Claude Code, Codex, Cursor, Gemini CLI, Grok Build və
[digər agentləri](../installation.md#supported-agents) dəstəkləyir. Provayder konfiqurasiyası və
əl ilə MCP qeydiyyatı üçün [quraşdırma və tənzimləmə](../installation.md) sənədinə baxın.

### Agentinizdən soruşun

```text
Notes tətbiqində axtarışın necə işlədiyini anla, mənə sübutları göstər və layihəm üçün
oxşar funksiya qur.
```

Notes əvəzinə hədəf tətbiqinizi və anlamaq istədiyiniz funksiyanı yazın.

### Terminaldan istifadə edin

Çıxarılmış JavaScript/Electron tətbiq qovluğunu və ya ASAR faylını araşdırın:

```bash
npx -y rea-agents@latest analyze-javascript-application /absolute/path/to/app --json
```

Nəticəyə modullar, importlar, Electron sərhədləri və onların sübutları daxildir.
Yolu öz hədəfinizlə əvəz edin, məsələn, Windows-da `"D:/apps/example"`.

Müntəzəm istifadə üçün `rea` əmrini quraşdırmaq üçün:

```bash
npm install --global rea-agents
rea --help
```

Yerli kod analizi üçün əvvəlcə provayder konfiqurasiya edin. Yerli əmrlər, provayder seçimi,
snapshot-lar və skriptləşdirmə üçün [CLI və Evidence bələdçisinə](../cli.md) baxın.

### REA-nı yeniləyin

REA sürətlə dəyişir və yeni buraxılışlar tez-tez xəta düzəlişləri ehtiva edir.
Quraşdırmanızı güncəl saxlayın.

`npm install --global` və ya `bun add --global` ilə quraşdırılmış CLI üçün:

```bash
rea update
```

`rea --update` bu yoxlanılmış iş axını üçün ləqəbdir və eyni qlobal çıxış
bayraqlarını qəbul edir. Onu digər əmr idarəetmələri ilə birləşdirərkən `rea update` istifadə edin.

Yeniləmə əmrləri stdout və stderr üçün cəmi ən çox 4 MiB saxlayır. Həddən böyük
metadata cavabları əmr başa çatdıqdan sonra rədd edilir; ətraflı (verbose) quraşdırmalar
məhdud diaqnostika ilə davam edir. İnsan üçün nəzərdə tutulmuş irəliləyiş çıxışı terminalın
backpressure-una riayət edir və göndərilmiş yazmaların tamamlanmasını gözləyir.

Bun ilə qlobal yeniləmələr Bun 1.2.17 və ya daha yeni versiya tələb edir. Daha köhnə Bun
buraxılışı ilə `rea update` işlətməzdən əvvəl Bun-u əl ilə yeniləyin.

Agent qeydiyyatlarınızı və skill-i yeniləmək üçün yeniləmənin çap etdiyi
quraşdırma əmrini işlədin.

`npx` istifadə edirsinizsə, agent quraşdırmanızı bu əmrlə yeniləyin:

```bash
npx rea-agents@latest setup
```

Quraşdırma dəyişikliklərinə baxın və agentinizi yenidən başladın. Birdəfəlik CLI əmrləri üçün
`npx rea-agents@latest`, ardınca isə əmri yazın. Bun ilə `npx rea-agents@latest` əvəzinə
`bunx rea-agents@latest` istifadə edin.

## REA necə işləyir

Agentiniz hədəfi araşdırmaq və müvafiq kodu izləmək üçün MCP vasitəsilə REA-nı çağırır.
REA tapıntıları sübutları ilə birlikdə qaytarır. Agent onlardan əlavə suallar vermək,
davranışı izah etmək və ya implementasiya yazıb test etmək üçün istifadə edir.
CLI əmrləri eyni iş axınlarından istifadə edir.

![REA araşdırma axını: agentiniz lokal hədəf haqqında soruşur, REA analiz alətləri ilə onu araşdırır və izləyir, agent isə qaytarılan kod, istinadlar və naməlumlardan izah etmək, implementasiya etmək və test etmək üçün istifadə edir.](../../website/public/assets/figures/rea-investigation-flow.svg)

[Şəkli tam ölçüdə açın](../../website/public/assets/figures/rea-investigation-flow.svg).

<a id="current-status"></a>

## Nələri analiz edə bilərsiniz

REA Node.js 22.x (>=22.19), 24.x (>=24.11) və ya 26+, həmçinin npm tələb edir.
Əlavə alətlər və host dəstəyi hədəfdən asılıdır:

| Hədəf                           | REA nə qaytarır                                                                                          | Tələblər və bələdçi                                                                                                                |
| ------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Yerli binar fayllar             | Psevdokod, assembly, sətirlər, simvollar, çağırışlar və istinadlar                                       | Hopper, Ghidra və ya IDA; [yerli kod analizi](../native-investigation.md)                                                          |
| Oflayn ELF strukturu            | Bölmələr, seqmentlər, orijinal simvollar/relokasiyalar və statik qoruma mexanizmi namizədləri            | Linux x64-də çağıranın təmin etdiyi pwntools; [binar diaqnostika](../binary-diagnostics.md)                                        |
| Go binar faylları               | Daxil edilmiş kompilyator versiyası, modullar, əvəzləmələr və build parametrləri                         | Daxili statik ELF/PE/thin Mach-O yoxlaması; Go quraşdırması tələb olunmur                                                          |
| Rust binar faylları             | Daxil edilmiş cargo-auditable crate adları, versiyaları, mənbələri və asılılıq əlaqələri                 | Daxili statik ELF/PE/thin Mach-O yoxlaması; [Rust binar faylları](../rust-binaries.md)                                             |
| WASM artefaktı                  | Validasiya, bölmələr, dəqiq import/export WAT formaları və dekod edilmiş WAT                             | Çağıranın təmin etdiyi WABT 1.0.42; `inspect_wasm_artifact`                                                                        |
| EVM bytecode                    | Dispetçer selektorları, bayt ofsetləri, çıxarılmış arqumentlər və dəyişkənlik (mutability)               | Linux x64-də lokal raw/hex daşıyıcı; [oflayn EVM bələdçisi](../evm-bytecode.md)                                                    |
| SQLite verilənlər bazaları      | Cədvəllər, sütunlar, indekslər, view-lar, trigger-lər və seçilmiş adi cədvəl sətirləri                   | Lokal verilənlər bazası/WAL snapshot-ı; native SQLite limitləri ilə Node.js 24.x >=24.15 və ya 26+                                 |
| Qeydə alınmış Linux çökmələri   | Xam note-lar, qeydə alınmış hər bir thread-in registrləri/siqnalları və istəyə bağlı mapping namizədləri | Linux x64-də çağıranın təmin etdiyi pwntools; istəyə bağlı GDB/pwndbg; [qeydə alınmış çökmələr](../recorded-crashes.md)            |
| JavaScript / Electron           | Modullar, importlar, source map-lər, marşrutlar, IPC və native add-on əlaqələri                          | Node.js və npm; Linux: procps ilə uyğun `ps`; [tətbiq analizi](../javascript-application-workflows.md)                             |
| Vebsaytlar                      | Səhifə strukturu, skriptlər, şəbəkə müşahidələri və tələb olunan ekran görüntüləri                       | Chrome ailəsindən brauzer; [brauzer analizi](../browser-observation.md)                                                            |
| Saxlanılmış şəbəkə trafiki      | Sorğular, cavablar, açıq qalan payload-lar və mənbə yerləri                                              | HAR və ya Fiddler Everywhere SAZ; native mitmproxy üçün Linux-da mitmdump; [trafik bələdçisi](../web-network-captures.md)          |
| .NET assembly-ləri              | Metadata, CIL təlimatları, elan edilmiş native asılılıqlar və build müqayisələri                         | Yoxdur (yalnız statik); [idarə olunan kod bələdçisi](../managed-code-analysis.md)                                                  |
| Android APK-ları                | Manifest bəyannamələri, siniflər, dekompilyasiya edilmiş metodlar və istinadlar                          | Linux/macOS/Windows x64-də headless JADX və tam JDK; [Android bələdçisi](../android-analysis.md)                                   |
| Android cihazları               | Cihazlar, paketlər, proseslər, loglar, dump-lar, ekran görüntüləri və APK/fayl ötürmələri                | Çağıranın təmin etdiyi adb (emulyator və ya cihaz); [ADB bələdçisi](../adb-device-analysis.md)                                     |
| JEB layihələri                  | Mühərrikə əsaslanan layihə vahidləri, artefakt həşləri və tip/metod psevdokodu                           | Çağıranın işə saldığı, MCP təqdim edən JEB klienti, REA_JEB_MCP_URL ilə seçilir; [JEB bələdçisi](../jeb-analysis.md)               |
| Android resursları              | Dekod edilmiş manifest, sətir cədvəlləri, lokallar və versiya faktları                                   | Çağıranın təmin etdiyi Apktool başladıcısı; [resurs bələdçisi](../apktool-resource-analysis.md)                                    |
| Flutter tətbiqləri              | Dart snapshot həşi, hər ABI üçün kitabxana həşləri və mühərrik build mənşəyi                             | Yoxdur (statik APK təhlili); [Flutter bələdçisi](../flutter-analysis.md)                                                           |
| Firmware                        | Regionlar, çıxarma nəticələri və yerli kod analizinə ötürmələr                                           | Linux-da Binwalk / Unblob; [firmware bələdçisi](../firmware-analysis.md)                                                           |
| Qeydə alınmış paketlər          | Seçilmiş sahələr, təkrarlanan dəyərlər, filtrlər və decode-as qaydaları                                  | Linux: TShark 4.x + prlimit; [trafik bələdçisi](../packet-captures.md)                                                             |
| Paket xülasələri                | Endpoint-lər, DNS, TLS SNI, protokol paylanması və HTTP sorğuları                                        | Çağıranın təmin etdiyi tshark və capinfos (Linux-da yoxlanılıb); [pcap bələdçisi](../pcap-analysis.md)                             |
| Qeydə alınmış məntiqi siqnallar | Dekoder annotasiyaları, nümunə diapazonları və diaqnostika                                               | Linux: sigrok-cli 0.7.2 + prlimit; [siqnal yazıları](../signal-recordings.md)                                                      |
| Paketlər və resurslar           | Fayl inventarları, həşlər, plist-lər, Apple bundle anatomiyası və çıxarılmış resurslar                   | [Artefakt və JavaScript bələdçisi](../javascript-artifact-reconstruction.md), [Apple tətbiqləri](../apple-application-analysis.md) |
| Proses davranışı                | Terminal çıxışı, qarşılıqlı təsirlər, çıxış və fayl sistemi müşahidələri, işə salmaların müqayisəsi      | Native PTY ilə Linux/macOS; [proses qeydə alınması](../process-capture.md)                                                         |

Statik JavaScript və .NET yoxlaması tətbiqi işə salmadan təqdim edilmiş faylları oxuyur.
İcra zamanı qeydə alma seçilmiş hədəfi sizin istifadəçi icazələrinizlə işə salır və ya onunla
qarşılıqlı əlaqəyə girir; hər bir icra zamanı bələdçisi onun təsirlərini təsvir edir.

Oflayn yerli binar yoxlaması üçün REA çağıranın təmin etdiyi GNU objdump və Rizin-i də
dəstəkləyir. Provayder quraşdırması, CLI əmrləri və Evidence məhdudiyyətləri üçün
[tərs mühəndislik alətləri bələdçisinə](../reverse-engineering-tools.md) baxın. REA
heç bir provayderi quraşdırmır və ya yeniləmir.

<a id="choosing-a-deep-analysis-provider"></a>

Yerli formatlar və host dəstəyi provayderə görə dəyişir. Bax:
[Hopper və Ghidra quraşdırması](../installation.md#hopper),
[IDA bələdçisi](../ida-provider.md) (istəyə bağlı native MCP körpüsü daxil olmaqla),
[Kuna dekompilyator bələdçisi](../kuna-provider.md) və
[eksperimental Windows Ghidra dəstəyi](../windows-ghidra-p0.md).
Ghidra həmçinin [16 bitlik DOS analizini](../ghidra-dos.md) dəstəkləyir.
Böyük binar fayllar üçün provayderin başlanğıc vaxt limitini
`REA_GHIDRA_STARTUP_TIMEOUT_MS` və ya `REA_HOPPER_STARTUP_TIMEOUT_MS` ilə artırın.
Provayder seçimi üçün [CLI bələdçisinə](../cli.md#choose-a-provider) baxın.
Son npm buraxılışından sonra əlavə edilmiş funksiyalar üçün
[buraxılışlarda mövcudluğu](../installation.md#released-package-and-main) yoxlayın.

## Nümunələr

[![DX-Ball səs panoraması, Notion mübadilə buferi körpüsü və TH04 güllə halqası nümunələrinin illüstrasiyaları](../assets/rea-showcases.png)](https://rea.tools/showcase/)

### DX-Ball: səs panoraması hesablamasının bərpası

Səs çağırışını onun mövqeyi panoramaya çevirən köməkçi funksiyasına qədər izləyin,
təlimatları araşdırın və natamam psevdokodu C-yə çevirin. Bərpa edilmiş kod
3 205 orijinal x86 halını keçir və kompilyasiya olunmuş funksiyanın bütün 63 baytını təkrar yaradır.

[Nümunəni oxuyun](https://rea.tools/showcase/dx-ball/) ·
[Bərpa repozitoriyası](https://github.com/N0zoM1z0/dx-ball)

### Notion: Electron mübadilə buferi körpüsünün izlənməsi

Renderer prosesinin mübadilə buferi API-sini tapın, onu preload və IPC vasitəsilə
əsas prosesə qədər izləyin və zəngin mübadilə buferi formatını araşdırın.

[Nümunəni oxuyun](https://rea.tools/showcase/notion/)

### TH04: DOS güllə halqası hesablamasının bərpası

Orijinal PC-98 oyununun 16 bitlik təlimatlarını araşdırın, sabit və hədəfə
yönəlmiş bucaq hesablamalarını bərpa edin və bərpa olunmuş C++ kodunu
tarixi kompilyator çıxışı ilə müqayisə edin.

[Nümunəni oxuyun](https://rea.tools/showcase/th04/) ·
[Bərpa repozitoriyası](https://github.com/N0zoM1z0/th04)

REA-dan maraqlı bir şey üçün istifadə etmisinizsə, onu görmək istərdik. Nümunənizi
[issue](https://github.com/morluto/rea/issues) və ya
[pull request](https://github.com/morluto/rea/pulls) vasitəsilə paylaşın; hədəfi,
sualınızı, REA-nın necə kömək etdiyini və nə tapdığınızı qeyd edin.

## Tez-tez verilən suallar

<details>
<summary><strong>Hansı agentlər REA-dan istifadə edə bilər?</strong></summary>

Lokal MCP serverlərini dəstəkləyən istənilən agent. Quraşdırma
[dəstəklənən agentləri](../installation.md#supported-agents) konfiqurasiya edir; digər klientlər
[əl ilə MCP qeydiyyatından](../installation.md#mcp-registry) istifadə edə bilər.

</details>

<details>
<summary><strong>Mənə Hopper, Ghidra və ya IDA lazımdır?</strong></summary>

Dərin yerli kod analizi onlardan birini istifadə edir. Statik JavaScript və .NET yoxlaması
yerli analiz mühərriki olmadan işləyir. Quraşdırma təsdiqdən sonra Hopper-i quraşdıra bilər;
Ghidra və IDA mövcud quraşdırmalarınızdan istifadə edir. [Provayder quraşdırmasına](../installation.md#hopper) baxın.

</details>

<details>
<summary><strong>Əvvəlcə Hopper-i işə salmalıyam?</strong></summary>

Əməliyyat Hopper tələb etdikdə REA onu özü işə salır. macOS-da ilk işə salınma zamanı
dialoq pəncərəsi sizdən demo rejimini seçməyi və ya lisenziyanızı aktivləşdirməyi xahiş edə bilər.
Bu sorğunu ilk CLI/MCP əməliyyatınızdan və ya nəzarətsiz tapşırığınızdan əvvəl eyni
istifadəçi sessiyasında tamamlayın. Lazım gələrsə, Hopper-i əl ilə açın. Bax:
[Hopper-in işə salınması və problemlərin həlli](../installation.md#launcher-paths-and-troubleshooting).

</details>

<details>
<summary><strong>skills.sh-dən skill quraşdırmaq nə edir?</strong></summary>

Skill agentinizə araşdırma təlimatları verir. REA-nın MCP serverini qeydiyyatdan keçirmək
və uyğun təlimatları quraşdırmaq üçün `npx rea-agents setup` istifadə edin, sonra agentinizi
yenidən başladın. [Yalnız skill quraşdırması](../installation.md#skill-only-installation) sənədinə baxın.

</details>

<details>
<summary><strong>REA hansı kodu qaytarır?</strong></summary>

Yerli kod analizi psevdokod və assembly qaytarır. JavaScript/Electron analizi
modulları və onların əlaqələrini bərpa edir. Agentiniz bu tapıntılardan implementasiya
yazmaq və test etmək üçün istifadə edir; [nümunələr](#nümunələr) praktik misallar göstərir.

</details>

<details>
<summary><strong>REA tətbiqimi yükləyir (upload edir)?</strong></summary>

REA hədəfləri lokal olaraq analiz edir. Agentiniz alət nəticələrini alır və onun
model provayderinin öz məlumat siyasəti var.

</details>

<details>
<summary><strong>Xəta ilə qarşılaşsam nə etməliyəm?</strong></summary>

Əvvəlcə yeniləyin; son buraxılış artıq onu düzəltmiş ola bilər.

`npm install --global` və ya `bun add --global` ilə quraşdırılmış CLI üçün:

```bash
rea update
```

`npx` vasitəsilə agent quraşdırması üçün:

```bash
npx rea-agents@latest setup
```

Agentdən istifadə edirsinizsə, [quraşdırmanın yenilənməsini](#rea-nı-yeniləyin) tamamlayın və onu
yenidən başladın. Eyni tapşırığı təkrar yoxlayın. Problem davam edərsə, REA versiyanız, hədəf
növü, təkrarlama addımları və xəta çıxışı ilə [issue açın](https://github.com/morluto/rea/issues).

</details>

## Sənədlər

Vebsaytdakı [praktik bələdçilərdən](https://rea.tools/guides/) başlayın.
Dəqiq seçimlər, ilkin şərtlər və nəticə müqavilələri üçün:

- [Quraşdırma və tənzimləmə](../installation.md): agent qeydiyyatı, provayder konfiqurasiyası, yeniləmələr və silinmə.
- [Hazırlıq və problemlərin həlli](../installation.md#check-readiness-for-your-task): bir agentin və ya analiz mühərrikinin diaqnostikası.
- [CLI və Evidence](../cli.md): əmrlər, provayder seçimi, snapshot-lar, import/export və çıxış statusları.
- [MCP müqavilələri](../mcp-contracts.md) və [agent prompt-ları](../mcp-prompts.md): alət nəticələri, sessiyalar və istiqamətləndirilmiş araşdırmalar.
- [Alət kataloqu](../mcp-contracts.md#generated-catalog): alətlərin, provayderlərin və CLI əmrlərinin avtomatik yaradılmış inventarı.
- [Yol xəritəsi](../roadmap.md): planlaşdırılan işlər və imkan izləyiciləri.

Zəiflikləri [SECURITY.md](../../SECURITY.md) vasitəsilə bildirin.

## Ulduz tarixçəsi

🎉 **300 000 GitHub ulduzu — təşəkkür edirik!**

REA-dan istifadə edən, xətalar barədə məlumat verən, funksiya tələb edən, build-ləri test edən və düzəlişlərlə töhfə verən hər kəsə təşəkkürlər.

<a href="https://www.star-history.com/?repos=morluto%2Frea&amp;type=date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date&amp;theme=dark&amp;legend=top-left" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date" />
    <img alt="REA GitHub ulduz tarixçəsi" src="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date" />
  </picture>
</a>

## Məsuliyyətdən imtina

Məsuliyyətli istifadə qaydaları üçün [DISCLAIMER.md](../../DISCLAIMER.md) faylına baxın.

Layihənin qanunsuz və ya icazəsiz istifadəyə dair mövqeyi bütün REA versiyalarını,
yayım kanallarını və platformaları əhatə edir; hər bir nüsxə tətbiq olunan lisenziyalarını saxlayır.

REA qanuni tədqiqat, təhsil, qarşılıqlı uyğunluq, proqram təminatının qorunması
və sizə məxsus olan və ya araşdırmağa icazəniz olan proqram təminatının analizi üçündür.

## Töhfə vermək

REA-ya köməyinizi məmnuniyyətlə qəbul edirik! Xəta bildirmək və ya funksiya təklif etmək üçün
[issue açın](https://github.com/morluto/rea/issues), kodu və ya sənədləri təkmilləşdirmək üçün isə
[pull request göndərin](https://github.com/morluto/rea/pulls).

İnkişaf mühitinin qurulması və yoxlamalar üçün [CONTRIBUTING.md](../../CONTRIBUTING.md),
yoxlama mərhələləri üçün [test bələdçisi](../testing.md) və layihə strukturu üçün
[arxitektura xəritəsi](../architecture.mermaid) sənədlərinə baxın.

## Lisenziya

[MIT](../../LICENSE)

REA tərəfindən yazılmış kod MIT lisenziyası altındadır. Üçüncü tərəf materialları
öz lisenziyalarını və müəllif hüququ bildirişlərini saxlayır; asılılıq inventarı,
qorunan lisenziya mətnləri və xarici alət şərtləri üçün
[Üçüncü tərəf bildirişləri](../../THIRD_PARTY_NOTICES.md) sənədinə baxın.

**IDA Pro / Hex-Rays dekompilyatorları, Hopper və JEB daxil olmaqla kommersiya alətlərini
qanuni yolla əldə etməli və onların tətbiq olunan lisenziyaları çərçivəsində istifadə etməyə
icazəniz olmalıdır.** REA heç bir alət lisenziyası, açar və ya aktivləşdirmə hüququ vermir.
Sınaq və demo versiyalar istifadəçi, funksiya, avtomatlaşdırma və çıxışın paylaşılması
məhdudiyyətləri daxil olmaqla, təchizatçı şərtlərinə tabedir. Sındırılmış nüsxələr, oğurlanmış
açarlar, açarların icazəsiz paylaşılması və lisenziya məhdudiyyətlərinin yan keçilməsinə icazə
verilmir. Bu təlimat MIT və ya üçüncü tərəf lisenziyalarını dəyişdirmir.
