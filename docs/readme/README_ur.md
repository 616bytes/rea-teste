<div align="center">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · **اردو** · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md)
· [Ελληνικά](README_el.md)

# REA: کسی بھی چیز کی ریورس انجینیئرنگ

### بائنریز، ایپلیکیشنز اور رن ٹائم رویے کے لیے ایک ہی MCP سے ریورس انجینیئرنگ۔

**کوئی فیچر پسند آیا؟ سمجھیں کہ وہ کیسے کام کرتا ہے، بائنری کی سطح تک۔**

[![npm version](https://img.shields.io/npm/v/rea-agents?style=flat-square&color=cb3837)](https://www.npmjs.com/package/rea-agents)
[![MCP tool catalog](https://img.shields.io/badge/MCP-tool_catalog-5c4ee5?style=flat-square)](../mcp-contracts.md#generated-catalog)
[![Node.js requirements](https://img.shields.io/badge/Node.js-requirements-339933?style=flat-square&logo=nodedotjs&logoColor=white)](#current-status)
[![skills.sh](https://skills.sh/b/morluto/rea?style=flat-square)](https://skills.sh/morluto/rea/reverse-engineer-anything)
[![MIT license](https://img.shields.io/badge/license-MIT-f4c430?style=flat-square)](../../LICENSE)
[![Discord](https://img.shields.io/discord/1556595354999332884?logo=discord&logoColor=white&label=Discord&color=5865F2)](https://discord.gg/GkcryMnJDM)

<a href="https://trendshift.io/repositories/82054?utm_source=repository-badge&amp;utm_medium=badge&amp;utm_campaign=badge-repository-82054" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/repositories/82054" alt="morluto%2Frea | Trendshift" width="250" height="55"/></a>

**[ویب سائٹ](https://rea.tools/) · [گائیڈز](https://rea.tools/guides/) · [کیس اسٹڈیز](https://rea.tools/showcase/)**

[فوری آغاز](#فوری-آغاز) · [REA کیسے کام کرتا ہے](#rea-کیسے-کام-کرتا-ہے) · [آپ کیا تجزیہ کر سکتے ہیں](#آپ-کیا-تجزیہ-کر-سکتے-ہیں) · [کیس اسٹڈیز](#کیس-اسٹڈیز) · [عام سوالات](#عام-سوالات) · [دستاویزات](#دستاویزات)

<code>npx rea-agents setup</code>

</div>

> [!IMPORTANT]
> REA صرف سرکاری ذرائع سے لیں: [morluto/rea](https://github.com/morluto/rea),
> [rea.tools](https://rea.tools/), یا [rea-agents npm package](https://www.npmjs.com/package/rea-agents)۔
> انسٹالیشن اور ریلیز لنکس انہی سرکاری ذرائع سے لیں۔ ملتا جلتا ریپو نام یا نقل شدہ README اس بات کا ثبوت نہیں کہ ڈاؤن لوڈ اصلی ہے۔

<div align="center">

<br />

<img src="../assets/rea-hopper-analysis.png" alt="REA ایک نیٹو بائنری کا معائنہ کرتے ہوئے Hopper کے اندر اپنا analysis bridge چلا رہا ہے" width="1200" />

<br /><br />

<table aria-label="REA community">
<tr>
<td align="center" width="360">
  <a href="https://discord.gg/GkcryMnJDM">
    <img src="../assets/discord.svg" height="42" alt="Discord" /><br />
    <strong>ریورس انجینیئرنگ کمیونٹی میں شامل ہوں</strong>
  </a><br />
  <sub>Discord · سوال و جواب · اپنا کام دکھائیں</sub>
</td>
</tr>
</table>

<br />

</div>

---

کسی ایپ میں کوئی فیچر دیکھا جو آپ اپنی پروڈکٹ میں چاہتے ہیں؟ اپنے ایجنٹ سے کہیں کہ REA کے ذریعے اس کی چھان بین کرے۔ یہ ایپ کو اس کے سورس کوڈ کے بغیر جانچ سکتا ہے، سمجھا سکتا ہے کہ فیچر کیسے کام کرتا ہے، شواہد دکھا سکتا ہے، اور آپ کے پروجیکٹ کے لیے اس کا ایک ورژن بنا سکتا ہے۔

REA آپ کے ایجنٹ کو ایسے اوزاروں سے جوڑتا ہے جو نیٹو بائنریز، JavaScript اور Electron ایپس، .NET assemblies اور ویب سائٹس کا معائنہ کرتے ہیں۔ یہی اوزار آپ ٹرمینل سے بھی استعمال کر سکتے ہیں۔ تجزیہ مقامی طور پر (locally) چلتا ہے، اور نتائج کے ساتھ ہر نتیجے کے پیچھے کے شواہد اور حدود بھی آتی ہیں۔

سیٹ اپ REA کو آپ کے ایجنٹ کے ساتھ رجسٹر کرتا ہے اور مماثل workflow ہدایات انسٹال کرتا ہے۔ نیٹو تجزیہ کے لیے پہلے سے موجود Hopper، Ghidra یا IDA استعمال ہو سکتا ہے؛ سیٹ اپ آپ کی اجازت سے Hopper بھی انسٹال کر سکتا ہے۔ JavaScript کے static تجزیے کے لیے کسی نیٹو analysis engine کی ضرورت نہیں۔

> **[REA کی ویب سائٹ دیکھیں](https://rea.tools/)** تاکہ سیٹ اپ ہدایات، تصویری گائیڈز اور حقیقی کیس اسٹڈیز مل سکیں۔

## فوری آغاز

Linux پر، Ghidra، JADX، firmware اوزاروں کا اجرا اور static JavaScript/Electron تجزیے کے لیے REA کے `PATH` میں procps کے موافق `ps` کا ہونا ضروری ہے (process ownership جانچ کے لیے)۔ بحالی کے اقدامات `docs/installation.md` میں "Linux owned-process prerequisite" کے تحت ہیں۔

### اپنا ایجنٹ سیٹ کریں

Node.js اور npm انسٹال ہونے کے بعد، چلائیں:

```bash
npx rea-agents setup
```

اپنے ایجنٹ منتخب کریں، تجویز کردہ تبدیلیاں دیکھیں اور منظور کریں۔ سیٹ اپ REA کا MCP server اور مماثل workflow ہدایات شامل کرتا ہے، اور موجودہ configuration کا backup بھی رکھتا ہے۔ بعد میں اپنا ایجنٹ ری اسٹارٹ کریں۔

سیٹ اپ Claude Code، Codex، Cursor، Gemini CLI، Grok Build اور [دیگر ایجنٹس](../installation.md#supported-agents) کو سپورٹ کرتا ہے۔ provider configuration اور manual MCP registration کے لیے [installation and setup](../installation.md) دیکھیں۔

### اپنے ایجنٹ سے پوچھیں

```text
Understand how search works in the Notes app, show me the evidence, and build a
similar feature for my project.
```

Notes کی جگہ اپنی ہدف ایپ اور وہ فیچر رکھیں جسے آپ سمجھنا چاہتے ہیں۔

### ٹرمینل استعمال کریں

کسی نکالی گئی JavaScript/Electron ایپ ڈائریکٹری یا ASAR کا معائنہ کریں:

```bash
npx -y rea-agents@latest analyze-javascript-application /absolute/path/to/app --json
```

نتیجے میں modules، imports، Electron boundaries اور ان کے شواہد شامل ہوتے ہیں۔ path کی جگہ اپنا ہدف رکھیں، جیسے Windows پر `"D:/apps/example"`۔

باقاعدہ استعمال کے لیے `rea` کمانڈ انسٹال کرنے کو:

```bash
npm install --global rea-agents
rea --help
```

نیٹو تجزیے کے لیے پہلے ایک provider configure کریں۔ نیٹو کمانڈز، provider انتخاب، snapshots اور scripting کے لیے [CLI and Evidence guide](../cli.md) دیکھیں۔

### REA کو اپ ڈیٹ کریں

REA تیزی سے بدلتا ہے، اور نئی ریلیزز میں اکثر bug fixes ہوتی ہیں۔ اپنی تنصیب کو اپ ڈیٹ رکھیں۔

`npm install --global` یا `bun add --global` سے انسٹال کردہ CLI کے لیے:

```bash
rea update
```

Bun کے global اپ ڈیٹس کے لیے Bun 1.2.17 یا بعد کا ورژن چاہیے۔ پرانے Bun پر، `rea update` چلانے سے پہلے Bun کو خود اپ گریڈ کریں۔

اپنے ایجنٹ کی registrations اور skill تازہ کرنے کے لیے، اپ ڈیٹ کے بعد دکھائی گئی setup کمانڈ چلائیں۔

اگر آپ `npx` استعمال کرتے ہیں تو اپنے ایجنٹ کا سیٹ اپ یوں اپ ڈیٹ کریں:

```bash
npx rea-agents@latest setup
```

سیٹ اپ کی تبدیلیاں دیکھیں اور اپنا ایجنٹ ری اسٹارٹ کریں۔ ایک بار کی CLI کمانڈز کے لیے `npx rea-agents@latest` کے بعد کمانڈ لگائیں۔ Bun کے ساتھ `npx rea-agents@latest` کی جگہ `bunx rea-agents@latest` استعمال کریں۔

## REA کیسے کام کرتا ہے

آپ کا ایجنٹ MCP کے ذریعے REA کو بلاتا ہے تاکہ ہدف کا معائنہ کرے اور متعلقہ کوڈ کا سراغ لگائے۔ REA اپنے شواہد کے ساتھ نتائج واپس کرتا ہے۔ ایجنٹ ان کی مدد سے مزید سوال کرتا ہے، رویے کی وضاحت کرتا ہے، یا ایک implementation لکھ کر جانچتا ہے۔ CLI کمانڈز بھی یہی workflows استعمال کرتی ہیں۔

![REA کا تحقیقی بہاؤ: آپ کا ایجنٹ ایک مقامی ہدف کے بارے میں پوچھتا ہے، REA تجزیہ اوزاروں سے اس کا معائنہ اور سراغ لگاتا ہے، اور ایجنٹ واپس آنے والے کوڈ، references اور نامعلوم نکات سے وضاحت، implementation اور جانچ کرتا ہے۔](../../website/public/assets/figures/rea-investigation-flow.svg)

[مکمل سائز کا خاکہ کھولیں](../../website/public/assets/figures/rea-investigation-flow.svg)۔

<a id="current-status"></a>

## آپ کیا تجزیہ کر سکتے ہیں

REA کے لیے Node.js 22.x (>=22.19)، 24.x (>=24.11)، یا 26+ اور npm درکار ہیں۔ اضافی اوزار اور host سپورٹ ہدف کے مطابق بدلتی ہے:

| ہدف | REA کیا واپس کرتا ہے | تقاضے اور گائیڈ |
| ---------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| نیٹو بائنریز | Pseudocode، assembly، strings، symbols، calls اور references | Hopper، Ghidra یا IDA؛ [native analysis](../native-investigation.md) |
| Offline ELF layout | Sections، segments، اصل symbols/relocations اور static mitigation candidates | Linux x64 پر caller کی فراہم کردہ pwntools؛ [binary diagnostics](../binary-diagnostics.md) |
| Go بائنریز | Embedded compiler version، modules، replacements اور build settings | بلٹ اِن static ELF/PE/thin Mach-O معائنہ؛ Go انسٹال کرنے کی ضرورت نہیں |
| Rust بائنریز | Embedded cargo-auditable crate نام، versions، sources اور dependency edges | بلٹ اِن static ELF/PE/thin Mach-O معائنہ؛ [Rust binaries](../rust-binaries.md) |
| WASM artifact | توثیق، sections، درست import/export WAT صورتیں اور decoded WAT | caller کی فراہم کردہ WABT 1.0.42؛ `inspect_wasm_artifact` |
| EVM bytecode | Dispatch selectors، byte offsets، اخذ کردہ arguments اور mutability | Linux x64 پر مقامی raw/hex carrier؛ [offline EVM guide](../evm-bytecode.md) |
| SQLite databases | Tables، columns، indexes، views، triggers اور منتخب ordinary-table rows | مقامی database/WAL snapshot؛ Node.js 24.x >=24.15 یا 26+ بمع native SQLite حدود |
| Recorded Linux crashes | خام نوٹس، ہر ریکارڈ شدہ thread کے registers/signals اور اختیاری mapping candidates | Linux x64 پر caller کی فراہم کردہ pwntools؛ اختیاری GDB/pwndbg؛ [recorded crashes](../recorded-crashes.md) |
| JavaScript / Electron | Modules، imports، source maps، routes، IPC اور native add-on تعلقات | Node.js اور npm؛ Linux: procps کے موافق `ps`؛ [application analysis](../javascript-application-workflows.md) |
| ویب سائٹس | صفحے کی ساخت، scripts، network مشاہدات اور درخواست کردہ screenshots | کوئی Chrome-family براؤزر؛ [browser analysis](../browser-observation.md) |
| محفوظ شدہ network captures | Requests، responses، ظاہر شدہ payloads اور source locations | HAR یا Fiddler Everywhere SAZ؛ native mitmproxy کے لیے Linux پر mitmdump؛ [capture guide](../web-network-captures.md) |
| .NET assemblies | Metadata، CIL instructions، اعلان کردہ native dependencies اور build موازنے | کچھ نہیں (صرف static)؛ [managed-code guide](../managed-code-analysis.md) |
| Android APKs | Manifest اعلانات، classes، decompiled methods اور references | Linux/macOS/Windows x64 پر headless JADX اور مکمل JDK؛ [Android guide](../android-analysis.md) |
| Android آلات | آلات، packages، processes، logs، dumps، screen captures، اور APK/فائل منتقلی | caller کی فراہم کردہ adb (emulator یا hardware)؛ [ADB guide](../adb-device-analysis.md) |
| JEB projects | Engine-backed project units، artifact digests اور type/method pseudo-code | caller کا شروع کردہ JEB client جو MCP فراہم کرے، REA_JEB_MCP_URL سے منتخب؛ [JEB guide](../jeb-analysis.md) |
| Android resources | Decoded manifest، string tables، locales اور version حقائق | caller کی فراہم کردہ Apktool launcher؛ [resource guide](../apktool-resource-analysis.md) |
| Flutter ایپس | Dart snapshot hash، فی ABI library digests اور engine build provenance | کچھ نہیں (static APK parsing)؛ [Flutter guide](../flutter-analysis.md) |
| Firmware | Regions، extraction نتائج اور native-analysis handoffs | Linux پر Binwalk / Unblob؛ [firmware guide](../firmware-analysis.md) |
| Recorded packets | منتخب fields، دہرائی گئی values، filters اور decode-as قواعد | Linux: TShark 4.x + prlimit؛ [capture guide](../packet-captures.md) |
| Packet summaries | Endpoints، DNS، TLS SNI، protocol تقسیم اور HTTP requests | caller کی فراہم کردہ tshark اور capinfos (Linux-verified)؛ [pcap guide](../pcap-analysis.md) |
| Recorded logic signals | Decoder annotations، sample ranges اور diagnostics | Linux: sigrok-cli 0.7.2 + prlimit؛ [signal recordings](../signal-recordings.md) |
| Packages اور resources | فائل inventories، digests، plists، Apple bundle ساخت اور نکالے گئے resources | [Artifact and JavaScript guide](../javascript-artifact-reconstruction.md)، [Apple applications](../apple-application-analysis.md) |
| Process behavior | Terminal output، تعاملات، exit اور filesystem مشاہدات، اور run موازنے | Linux/macOS بمع native PTY؛ [process capture](../process-capture.md) |

Static JavaScript اور .NET معائنہ فراہم کردہ فائلوں کو ایپلیکیشن چلائے بغیر پڑھتا ہے۔ Runtime capture آپ کی user permissions سے منتخب ہدف کو چلاتا یا اس سے تعامل کرتا ہے؛ ہر runtime گائیڈ اپنے اثرات بیان کرتی ہے۔

Offline نیٹو بائنری معائنے کے لیے REA، caller کی فراہم کردہ GNU objdump اور Rizin کو بھی سپورٹ کرتا ہے۔ provider سیٹ اپ، CLI کمانڈز اور Evidence حدود کے لیے [reverse-engineering tools guide](../reverse-engineering-tools.md) دیکھیں۔ REA ان میں سے کوئی provider خود انسٹال یا اپ ڈیٹ نہیں کرتا۔

<a id="choosing-a-deep-analysis-provider"></a>

نیٹو formats اور host سپورٹ provider کے مطابق بدلتی ہے۔ دیکھیں [Hopper and Ghidra setup](../installation.md#hopper)، [IDA guide](../ida-provider.md) (بشمول ایک اختیاری native MCP bridge)، [Kuna decompiler guide](../kuna-provider.md)، اور [experimental Windows Ghidra support](../windows-ghidra-p0.md)۔ Ghidra [16-bit DOS تجزیہ](../ghidra-dos.md) بھی سپورٹ کرتا ہے۔ بڑی بائنریز کے لیے provider کی startup deadline `REA_GHIDRA_STARTUP_TIMEOUT_MS` یا `REA_HOPPER_STARTUP_TIMEOUT_MS` سے بڑھائیں۔ provider انتخاب کے لیے [CLI guide](../cli.md#choose-a-provider) دیکھیں۔ تازہ ترین npm ریلیز کے بعد شامل ہونے والے فیچرز کے لیے [release availability](../installation.md#released-package-and-main) دیکھیں۔

## کیس اسٹڈیز

[![DX-Ball sound-pan، Notion clipboard-bridge، اور TH04 bullet-ring کیس اسٹڈیز کی تصاویر](../assets/rea-showcases.png)](https://rea.tools/showcase/)

### DX-Ball: ایک sound-pan حساب کی بازیابی

ایک sound call کا اس کے position-to-pan helper تک پیچھا کریں، instructions کا معائنہ کریں، اور نامکمل pseudocode کو C میں بدلیں۔ یہ بازیابی 3,205 اصل-x86 cases پاس کرتی ہے اور compiled function کے تمام 63 bytes دوبارہ پیدا کرتی ہے۔

[کیس اسٹڈی پڑھیں](https://rea.tools/showcase/dx-ball/) ·
[بازیابی ریپازٹری](https://github.com/N0zoM1z0/dx-ball)

### Notion: Electron clipboard bridge کا سراغ

renderer کی clipboard API تلاش کریں، اسے preload اور IPC سے ہوتے ہوئے main process تک لے جائیں، اور rich clipboard format کا معائنہ کریں۔

[کیس اسٹڈی پڑھیں](https://rea.tools/showcase/notion/)

### TH04: ایک DOS bullet-ring حساب کی بازیابی

اصل PC-98 گیم کی 16-bit instructions کا معائنہ کریں، fixed اور aimed angle حسابات بازیاب کریں، اور بازیاب شدہ C++ کا تاریخی compiler output سے موازنہ کریں۔

[کیس اسٹڈی پڑھیں](https://rea.tools/showcase/th04/) ·
[بازیابی ریپازٹری](https://github.com/N0zoM1z0/th04)

اگر آپ نے REA کسی دلچسپ چیز پر استعمال کیا ہو تو ہم اسے دیکھنا چاہیں گے۔ اپنا کیس کسی [issue](https://github.com/morluto/rea/issues) یا [pull request](https://github.com/morluto/rea/pulls) میں شیئر کریں، بشمول ہدف، آپ کا سوال، REA نے کیسے مدد کی، اور آپ کو کیا ملا۔

## عام سوالات

<details>
<summary><strong>کون سے ایجنٹس REA استعمال کر سکتے ہیں؟</strong></summary>

کوئی بھی ایجنٹ جو مقامی MCP servers سپورٹ کرے۔ سیٹ اپ [سپورٹ شدہ ایجنٹس](../installation.md#supported-agents) کو configure کرتا ہے؛ دیگر clients [manual MCP registration](../installation.md#mcp-registry) استعمال کر سکتے ہیں۔

</details>

<details>
<summary><strong>کیا مجھے Hopper، Ghidra یا IDA چاہیے؟</strong></summary>

گہرے نیٹو تجزیے کے لیے ان میں سے ایک درکار ہے۔ Static JavaScript اور .NET معائنہ کسی نیٹو analysis engine کے بغیر چلتا ہے۔ سیٹ اپ آپ کی اجازت سے Hopper انسٹال کر سکتا ہے؛ Ghidra اور IDA آپ کی موجودہ تنصیبات استعمال کرتے ہیں۔ دیکھیں [provider setup](../installation.md#hopper)۔

</details>

<details>
<summary><strong>کیا مجھے پہلے Hopper خود چلانا ہوگا؟</strong></summary>

جب کسی operation کو ضرورت ہو تو REA خود Hopper چلا دیتا ہے۔ macOS پر، پہلی بار ایک dialog آپ سے demo mode یا license activate کرنے کا پوچھ سکتا ہے۔ اپنی پہلی CLI/MCP operation یا بغیر نگرانی والے کام سے پہلے اسی user session میں وہ prompt مکمل کریں۔ ضرورت ہو تو Hopper خود کھولیں۔ دیکھیں [Hopper startup and troubleshooting](../installation.md#launcher-paths-and-troubleshooting)۔

</details>

<details>
<summary><strong>skills.sh سے skill انسٹال کرنے سے کیا ہوتا ہے؟</strong></summary>

skill آپ کے ایجنٹ کے لیے تحقیقی ہدایات فراہم کرتا ہے۔ REA کا MCP server رجسٹر کرنے اور مماثل ہدایات انسٹال کرنے کے لیے `npx rea-agents setup` استعمال کریں، پھر اپنا ایجنٹ ری اسٹارٹ کریں۔ دیکھیں [skill-only installation](../installation.md#skill-only-installation)۔

</details>

<details>
<summary><strong>REA کون سا کوڈ واپس کرتا ہے؟</strong></summary>

نیٹو تجزیہ pseudocode اور assembly واپس کرتا ہے۔ JavaScript/Electron تجزیہ modules اور ان کے تعلقات بازیاب کرتا ہے۔ آپ کا ایجنٹ ان نتائج سے ایک implementation لکھتا اور جانچتا ہے؛ [کیس اسٹڈیز](#کیس-اسٹڈیز) میں عملی مثالیں موجود ہیں۔

</details>

<details>
<summary><strong>کیا REA میری ایپ اپ لوڈ کرتا ہے؟</strong></summary>

REA ہدف کا تجزیہ مقامی طور پر کرتا ہے۔ آپ کا ایجنٹ ٹول کے نتائج وصول کرتا ہے، اور اس کے model provider کی اپنی data policy ہوتی ہے۔

</details>

<details>
<summary><strong>اگر کوئی bug آجائے تو کیا کروں؟</strong></summary>

پہلے اپ ڈیٹ کریں؛ ممکن ہے کوئی حالیہ ریلیز اسے پہلے ہی ٹھیک کر چکی ہو۔

`npm install --global` یا `bun add --global` سے انسٹال کردہ CLI کے لیے:

```bash
rea update
```

`npx` کے ذریعے ایجنٹ سیٹ اپ کے لیے:

```bash
npx rea-agents@latest setup
```

اگر آپ کوئی ایجنٹ استعمال کر رہے ہیں تو [setup refresh](#rea-کو-اپ-ڈیٹ-کریں) مکمل کر کے اسے ری اسٹارٹ کریں۔ وہی کام دوبارہ آزمائیں۔ اگر مسئلہ برقرار رہے تو اپنے REA ورژن، ہدف کی قسم، دہرانے کے مراحل اور error output کے ساتھ [ایک issue کھولیں](https://github.com/morluto/rea/issues)۔

</details>

## دستاویزات

ویب سائٹ کے [worked guides](https://rea.tools/guides/) سے شروع کریں۔ درست اختیارات، تقاضوں اور نتیجے کے contracts کے لیے:

- [Installation and setup](../installation.md): ایجنٹ registration، provider configuration، اپ ڈیٹس اور uninstall۔
- [Readiness and troubleshooting](../installation.md#check-readiness-for-your-task): کسی ایک ایجنٹ یا analysis engine کی تشخیص۔
- [CLI and Evidence](../cli.md): کمانڈز، provider انتخاب، snapshots، import/export اور exit statuses۔
- [MCP contracts](../mcp-contracts.md) اور [agent prompts](../mcp-prompts.md): ٹول نتائج، sessions اور رہنمائی شدہ تحقیقات۔
- [Tool catalog](../mcp-contracts.md#generated-catalog): اوزار، providers اور CLI کمانڈز کی generated فہرست۔
- [Roadmap](../roadmap.md): منصوبہ بند کام اور capability trackers۔

کمزوریاں [SECURITY.md](../../SECURITY.md) کے ذریعے رپورٹ کریں۔

## اسٹار ہسٹری

🎉 **250,000 GitHub stars — شکریہ!**

REA کو استعمال کرنے، bugs رپورٹ کرنے، فیچرز کی درخواست کرنے، builds جانچنے اور fixes میں حصہ ڈالنے والے ہر فرد کا شکریہ۔

<a href="https://www.star-history.com/?repos=morluto%2Frea&amp;type=date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date&amp;theme=dark&amp;legend=top-left" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date" />
    <img alt="REA GitHub star history" src="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date" />
  </picture>
</a>

## دستبرداری (Disclaimer)

ذمہ دارانہ استعمال کی رہنمائی کے لیے [DISCLAIMER.md](../../DISCLAIMER.md) دیکھیں۔

غیر قانونی یا غیر مجاز استعمال سے متعلق پروجیکٹ کا موقف REA کے تمام ورژنز، تقسیم کے ذرائع اور platforms پر لاگو ہوتا ہے؛ ہر کاپی اپنے قابلِ اطلاق licenses برقرار رکھتی ہے۔

REA قانونی تحقیق، تعلیم، interoperability، سافٹ ویئر کے تحفظ، اور ایسے سافٹ ویئر کے تجزیے کے لیے ہے جس کے آپ مالک ہیں یا جس کی جانچ کے آپ مجاز ہیں۔

## شراکت (Contributing)

ہم REA میں آپ کی مدد کے خواہاں ہیں! کسی bug کی رپورٹ یا فیچر کی تجویز کے لیے [ایک issue کھولیں](https://github.com/morluto/rea/issues)، یا کوڈ و دستاویزات بہتر بنانے کے لیے [ایک pull request بھیجیں](https://github.com/morluto/rea/pulls)۔

development سیٹ اپ اور جانچ کے لیے [CONTRIBUTING.md](../../CONTRIBUTING.md)، verification lanes کے لیے [testing](../testing.md)، اور پروجیکٹ ساخت کے لیے [architecture map](../architecture.mermaid) دیکھیں۔

## لائسنس

[MIT](../../LICENSE)

REA کا تحریر کردہ کوڈ MIT کے تحت لائسنس یافتہ ہے۔ فریقِ ثالث کا مواد اپنے licenses اور copyright نوٹس برقرار رکھتا ہے؛ dependency فہرست، محفوظ license متون اور بیرونی ٹول شرائط کے لیے [Third-party notices](../../THIRD_PARTY_NOTICES.md) دیکھیں۔

**آپ کے لیے commercial tools کا قانونی طور پر حصول اور استعمال کا مجاز ہونا لازمی ہے**، بشمول IDA Pro / Hex-Rays decompilers، Hopper اور JEB، ان کے قابلِ اطلاق licenses کے تحت۔ REA کوئی ٹول license، key یا activation حق نہیں دیتا۔ Trials اور demos vendor شرائط کے تابع رہتے ہیں، بشمول user، feature، automation اور output شیئرنگ کی پابندیاں۔ Cracked کاپیاں، چوری شدہ keys، غیر مجاز key شیئرنگ، اور license پابندیوں کو عبور کرنا مجاز نہیں۔ یہ رہنمائی MIT یا فریقِ ثالث کے licenses میں ترمیم نہیں کرتی۔
