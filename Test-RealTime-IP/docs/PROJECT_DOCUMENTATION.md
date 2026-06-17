# توثيق مشروع SCADA — Solar Plant

> توثيق فني شامل: السيرفر، البروتوكولات، تدفّق البيانات، الـ APIs، صفحات التشارت، وصفحة الانفرتر.
> (الشرح بالعربي والمصطلحات التقنية بالإنجليزي.)

---

## 1. نظرة عامة على المعمارية

المشروع متكوّن من **3 أجزاء منفصلة** بتشتغل مع بعض:

```
   أجهزة الموقع (PLCs / Modbus / IEC-104)
              │  (Modbus TCP / IEC 60870-5-104)
              ▼
 ┌─────────────────────────────┐        ┌──────────────────────────────┐
 │  UI / Realtime Server        │        │  Historian API Server         │
 │  server/server.js  (:5000)   │        │  ApiServer.js     (:3000)     │
 │  - يقرأ الأجهزة كل ثانية      │        │  - /history (binary/JSON)     │
 │  - Socket.IO للبث اللحظي      │        │  - auth / login               │
 │  - يخدم صفحات الـ HTML        │        │  - يقرأ من SQL Server         │
 └──────────────┬──────────────┘        └───────────────┬──────────────┘
                │ Socket.IO (live)                       │ HTTP (history)
                ▼                                        ▼
          ┌───────────────────────────────────────────────────┐
          │              المتصفح (web/ pages + js)             │
          │  dashboard, inverter, multitrend, charts ...       │
          └───────────────────────────────────────────────────┘
                              │
                              ▼
                    ┌──────────────────┐
                    │   SQL Server     │  (IndustrialDB.HistorianData)
                    │  بيخزّن الـ history │
                    └──────────────────┘
```

| الجزء | المسار | البورت | الدور |
|------|--------|--------|-------|
| **UI / Realtime Server** | `server/server.js` | 5000 | يقرأ الأجهزة لحظياً، يبثّ عبر Socket.IO، يخدم صفحات الويب |
| **Historian API** | `C:\Database for Dredging\SolarDatabase\v1 - Draft\src\api\ApiServer.js` | 3000 | يرجّع البيانات التاريخية من SQL، والـ auth |
| **SQL Server** | `IndustrialDB` | — | تخزين الـ HistorianData |
| **المتصفح** | `web/` | — | الصفحات + التشارت |

> ملاحظة مهمة: الـ **real-time** بييجي من سيرفر :5000 (Socket.IO)، والـ **history** بييجي من سيرفر :3000 (HTTP). دول تطبيقين مختلفين.

---

## 2. البروتوكولات المستخدمة وليه

### 2.1 Modbus TCP
- بيُستخدم لقراءة الأجهزة اللي بتدعم Modbus (Energy Meters، أجهزة كتير).
- **الكلاس:** `ModbusConnection` في [server.js](../server/server.js).
- بيقرأ **registers** على دفعات (batches) لتقليل عدد الطلبات.
- **ليه:** بروتوكول صناعي قياسي، بسيط، مدعوم في كل الأجهزة تقريباً، وسهل القراءة على دفعات.

### 2.2 IEC 60870-5-104 (IEC-104)
- بيُستخدم للأجهزة اللي بتتكلم بالبروتوكول ده (شائع في محطات الكهرباء والـ RTUs).
- **الكلاس:** `IEC104Client` في [server.js](../server/server.js).
- بيدعم **General Interrogation (GI)** الدورية، الـ U/S/I frames، والـ COT (Cause Of Transmission).
- **ليه:** معيار عالمي لأنظمة الكهرباء/الـ SCADA، بيدعم البثّ بالاستثناء (report by exception) والـ time-tagged data.

**الفكرة الموحّدة:** مهما كان البروتوكول، كل **tag** في النهاية بيتخزّن بنفس الشكل في `TagManager.tags` (اسم + قيمة + وحدة + نوع)، فباقي النظام مش بيهمّه التاج جه من Modbus ولا IEC-104.

---

## 3. ملف السيرفر `server/server.js` — شرح كل فانكشن/كلاس

### 3.1 إعدادات وأدوات مساعدة
| العنصر | السطر | الدور |
|--------|------|-------|
| `Logger` | ~19 | لوجر بسيط (info/warn/error) بطابع زمني |
| `appConfig` | ~29 | بيحمّل `config.json` |
| `CONFIG` | ~189 | الإعدادات الفعّالة: `port`(5000)، `updateInterval`(1000ms)، `modbusTimeoutMs`، `modbusAddressBase`، إعدادات الـ reconnect |
| `normalizePrefix` / `getPrefixRoom` / `extractKnownPrefix` | 62–134 | إدارة "غرف" الـ Socket.IO حسب الـ prefix (INV/EM/PR/WS) عشان كل صفحة تستقبل تاجاتها بس |
| `_setNoStore` / `_fetchAuthMe` / `requireLoginPage` / `requireAdminPage` | 142–183 | حماية الصفحات: بيتأكد إن المستخدم عامل login (بيسأل سيرفر الـ auth على :3000) |
| `sheetToJson` | 217 | يحوّل شيت إكسل لـ JSON (لتحميل إعدادات التاجات) |

### 3.2 `class IEC104Client` (السطر 265)
بيمثّل اتصال بجهاز IEC-104 واحد.
| الميثود | الدور |
|---------|-------|
| `constructor(config)` | يجهّز الـ IP/port والـ timers (t1/t2/t3) وإعدادات GI |
| `registerTag(asduAddress, ioa, tag)` | يربط عنوان (ASDU+IOA) بتاج معيّن |
| `connect()` | يفتح TCP socket، يبدأ الـ STARTDT، يربط أحداث data/close/error/timeout |
| `disconnect()` / `_handleDisconnect()` | قطع الاتصال + إطلاق إعادة الاتصال |
| `startReconnectLoop()` / `stopReconnectLoop()` | إعادة الاتصال التلقائي حسب `CONFIG.reconnect` |
| `sendGeneralInterrogation()` / `startPeriodicGI()` | يطلب كل القيم من الجهاز دورياً |
| `_sendUFrame/_sendSFrame/_sendIFrame` | إرسال الإطارات حسب البروتوكول |
| `_onData` / `_processAPDU` / `_processIFrame` / `_parse` | تحليل البايتات الواردة لقيم تاجات |
| `_updateTag(asdu, ioa, value, quality)` | يحدّث قيمة التاج في `TagManager` |
| `getStatus()` | حالة الجهاز (connected, ip, port…) |

### 3.3 `class ModbusConnection` (السطر 542)
بيمثّل اتصال بجهاز Modbus واحد.
| الميثود | الدور |
|---------|-------|
| `constructor(config)` | IP/port/unitId |
| `connect()` | يفتح Modbus TCP مع timeout |
| `readRegisters(registerType, address, count)` | يقرأ مجموعة registers |
| `writeRegister(address, value)` | يكتب قيمة (للأوامر) |
| `startReconnectLoop()/stopReconnectLoop()/_handleDisconnect()/disconnect()` | إدارة الاتصال |
| `getStatus()` | حالة الجهاز |

### 3.4 `class TagManager` (السطر 662) — القلب
بيدير كل التاجات والأجهزة.
| الميثود | الدور |
|---------|-------|
| `loadFromExcel(filePath)` | يقرأ `config/tags_config.xlsx` وينشئ كل التاجات + الأجهزة (Modbus/IEC) + يحدّد `actualTagId`, `chartable`, `unit`, `page`, `dataType` |
| `parseModbusAddressAndBit / normalizeModbusAddress / normalizeBitIndex` | تطبيع عناوين الـ Modbus والـ bit index |
| `normalizeDataType / dtToIecType` | تطبيع نوع البيانات (Int/Real/Bool/DInt…) |
| `getTagsForPage(p)` | تاجات صفحة معيّنة |
| `getTagInfo(n)` | معلومات تاج بالاسم |
| `getChartableTags()` | التاجات اللي ينفع ترسم (analog ولها actual_tag_id) |
| `compileExpressions()` | يجهّز معادلات الـ calc tags (تاجات محسوبة) |
| `buildModbusBatches()` | يجمّع الـ registers المتجاورة في دفعات قراءة واحدة (أداء) |

### 3.5 دوال معالجة القيم
| الدالة | السطر | الدور |
|--------|------|-------|
| `parseModbusValue(data, dt, bitIndex)` | 907 | يحوّل بايتات الـ register للقيمة حسب النوع (Int/Real/Bool…) |
| `applyEquation(value, eq, compiled)` | 930 | يطبّق معادلة scaling/تحويل على القيمة الخام |
| `evaluateCalcTags(tm)` | 969 | يحسب التاجات المحسوبة (اللي قيمتها معادلة على تاجات تانية) |

### 3.6 حلقة التحديث (الـ Polling loop)
| الدالة | السطر | الدور |
|--------|------|-------|
| `raceDeadline(promise, ms)` | 1031 | يمنع جهاز بطيء من تعطيل الدورة كلها (deadline per device) |
| `readDeviceBatched(dev, batches)` | 1064 | يقرأ كل دفعات جهاز Modbus، ويطبّق `parseModbusValue` + `applyEquation` |
| `updateTags()` | 1111 | **الدورة الرئيسية**: يقرأ كل الأجهزة بالتوازي، يحدّث القيم، يحسب الـ calc tags، **ويبثّ المتغيّر فقط** عبر Socket.IO |
| `startUpdateLoop()` | 1203 | يشغّل `updateTags()` كل `updateInterval` (1 ثانية) بشكل متكرّر |
| `tagChanged(prev, v)` | 1050 | **deadband**: يحدّد هل القيمة اتغيّرت فعلاً (تجاهل التغيّر الميكروسكوبي) |

#### آلية البثّ (مهمة جداً)
- السيرفر بيقرأ **كل** التاجات كل ثانية.
- لكنه **بيبثّ التاج فقط لو قيمته اتغيّرت** (deadband) — `DEADBAND_ABS=0.001`, `DEADBAND_REL=0.0005`.
- كل `FULL_REFRESH_MS` (3 ثواني) بيعمل **full refresh** يبعت كل القيم (عشان التاجات الثابتة والعملاء الجدد).
- ده بيقلّل حجم البثّ والـ CPU بشكل كبير. (ملاحظة: ده كان سبب إن الـ real-time chart يبان متقطّع — اتحلّ في صفحة المشاكل).

### 3.7 أحداث Socket.IO (السطر 1206)
| الحدث | الاتجاه | الدور |
|-------|---------|-------|
| `init` | server→client | أول ما العميل يتصل: يبعت `devices`, `tags` (snapshot القيم), `tagMeta` (actual_tag_id, chartable, unit, dataType) |
| `tag_updates` | server→client | مصفوفة بالتاجات المتغيّرة `[{ tag_name, value, unit, actual_tag_id, chartable }]` |
| `tag_update` | server→client | تحديث تاج واحد (بعد كتابة قيمة مثلاً) |
| `subscribe_prefix` / `unsubscribe_prefix` | client→server | الاشتراك في تاجات جهاز معيّن (INV001_ مثلاً) — كل صفحة تاخد تاجاتها بس |
| `use_subscriptions` | client→server | العميل يخرج من البثّ العام ويعتمد على الاشتراك per-prefix |
| `get_tag_info` | client→server (callback) | معلومات تاج |

### 3.8 الـ REST endpoints (السطر 1237+)
| الـ Endpoint | الدور | شكل الرد |
|--------------|-------|----------|
| `GET /api/config` | إعدادات التطبيق | `appConfig` |
| `GET /api/health` | صحة النظام | حالة |
| `GET /api/tags` | كل قيم التاجات | `{ success, data: { name: value } }` |
| `GET /api/tag/:name` | تاج واحد بالتفصيل | `{ success, data: { name, value, actual_tag_id, chartable, unit, dataType, protocolType, description } }` |
| `POST /api/tag/:name/write` | كتابة قيمة لجهاز | `{ success }` |
| `GET /api/chartable-tags` | التاجات القابلة للرسم | `{ success, data: [{ name, actual_tag_id, unit, page }] }` |
| `GET /api/tags/page/:p` | تاجات صفحة | `{ success, data: { name: {value, unit, actual_tag_id, chartable} } }` |
| `GET /api/devices` | حالة كل الأجهزة | `{ success, data: [...] }` |
| `GET /api/status` | إحصائيات | عدد التاجات/الأجهزة المتصلة |
| `GET /:page.html` | يخدم صفحات HTML (مع فحص login) | الصفحة |

---

## 4. تدفّق البيانات اللحظية (Real-time data flow)

```
الجهاز ──Modbus/IEC104──► updateTags() كل 1s
   │
   ├─ parseModbusValue + applyEquation  (تحويل البايتات لقيمة)
   ├─ evaluateCalcTags                  (التاجات المحسوبة)
   ├─ tagChanged? (deadband)            (نبعت المتغيّر بس)
   │
   └─► io.emit('tag_updates', [{ tag_name, value, unit, actual_tag_id, chartable }, ...])
            │
            ▼  (في المتصفح)
   main.js / inverter.js socket.on('tag_updates')
            │
            ├─ يحدّث القيم على الشاشة
            └─ ChartSystem.updateData(name, value)  (لو التشارت مفتوح)
```

**شكل الـ payload اللحظي:**
```json
[
  { "tag_name": "INV001_ActivePower", "value": 812.5, "unit": "kW", "actual_tag_id": 14, "chartable": true },
  { "tag_name": "EM001_Voltage",      "value": 398.2, "unit": "V",  "actual_tag_id": 3,  "chartable": true }
]
```

---

## 5. الـ Historian API (سيرفر :3000) — البيانات التاريخية

**الملف:** `ApiServer.js` — الـ endpoint: `GET /history`

### 5.1 الـ Query parameters
```
/history?tag_id=1
        &start_day=1&start_month=2&start_year=2025&start_hour=0&start_minute=0
        &end_day=3&end_month=6&end_year=2026&end_hour=17&end_minute=7
        &format=bin            ← اختياري: binary بدل JSON
        &resolution=1d         ← اختياري: تجميع server-side (نادر الاستخدام دلوقتي)
        &max_points=5000       ← اختياري: حد للنقط في وضع الـ aggregation
```

### 5.2 مسارين داخل الـ endpoint
1. **Raw path (الافتراضي):** بيرجّع **كل** النقط الخام للفترة في **query واحدة** (`sp_GetHistorianData`) بحد أقصى `MAX_RAW_ROWS = 5,000,000`.
2. **Aggregated path:** لو اتبعت `resolution`، بيستخدم `sp_GetHistorianDataAggregated` (متوسط + min/max لكل bucket).

### 5.3 شكل الرد

**JSON** (الافتراضي القديم):
```json
[
  { "DateTime": "2025-02-01T00:00:00.000Z", "Value": 23.18 },
  { "DateTime": "2025-02-01T00:00:01.000Z", "Value": 24.01 }
]
```

**Binary** (`format=bin`) — الأخف والأسرع:
- `Content-Type: application/octet-stream`
- محتواه `Float64` متتالية: `[t0, v0, t1, v1, ...]` — كل نقطة = 16 بايت (timestamp بالـ ms + value).
- Header إضافي `X-Point-Count`.
- **ليه binary؟** ~4× أصغر من JSON، والمتصفح **بيتخطّى `JSON.parse`** تماماً، فبيستحمل ملايين النقط.

### 5.4 قاعدة البيانات
- **الجدول:** `HistorianData(id, tag_id, tag_name, value FLOAT, raw_value, quality, timestamp DATETIME2)`.
- **Index:** `IX_HistorianData_TagId (tag_id, timestamp DESC)` — مهم لسرعة استعلام الفترة.
- **Procs:**
  - `sp_GetHistorianData` — يرجّع النقط الخام لفترة (ORDER BY timestamp DESC).
  - `sp_GetHistorianDataAggregated` — يجمّع في buckets زمنية ويرجّع AVG/MIN/MAX/COUNT لكل bucket.

---

## 6. صفحة الانفرتر — `inverter.html` + `inverter.js`

صفحة بتعرض جهاز inverter واحد في كل مرة (مع إمكانية التنقّل بين الأجهزة بالـ index).

**الملفات:**
- `web/pages/inverter.html` — الماركب.
- `web/js/inverter.js` — المنطق (IIFE module).
- بتستخدم `chart.js` المشترك للرسم.

**أهم الفانكشن في [inverter.js](../web/js/inverter.js):**
| الدالة | الدور |
|--------|-------|
| `ensureScadaClientShim()` | بينشئ `window.scadaClient` لو مش موجود — بيوفّر `getTagValue`, `getActualTagId`, `getTagInfo` للتشارت |
| `buildPrefix(idx)` | يبني الـ prefix بتاع الجهاز الحالي مثلاً `INV001_` |
| `readURL()/updateURL()` | يحفظ/يقرأ رقم الجهاز من الـ URL (مشاركة لينك مباشر) |
| `setupLimits()` | يحدّد أقل/أكبر index متاح |
| `render()` | يبني واجهة الجهاز (الحقول analog + digital) |
| `applyUpdates(updates)` | يطبّق `tag_updates` الواردة على الـ DOM (القيم تتحدّث لحظياً) |
| `buildDomCacheForCurrentIndex()` | كاش لعناصر الـ DOM لتحديث أسرع |
| `startSignalWatch()` | لو مفيش تحديث لفترة → يعرض "No signal" |
| `connectSocket()` | يتصل بـ Socket.IO، يسمع `init`/`tag_updates`، ويعمل `use_subscriptions` |
| `subscribeToCurrentPrefix()` | يشترك في تاجات الجهاز الحالي فقط (ويلغي اشتراك القديم) |
| `setIndex(val)` | يغيّر الجهاز المعروض + يعيد الاشتراك |
| `init()` | نقطة البداية: يقرأ config، يبني الواجهة، يربط الأزرار، يتصل |

**التكامل مع التشارت:** أي حقل قابل للرسم بيتعمله handler يفتح `ChartSystem.openChart(fieldName, color, actualTagId)`، والتشارت بياخد القيم اللحظية من `scadaClient.getTagValue`.

---

## 7. صفحات التشارت (مهم جداً)

### 7.1 `web/js/chart.js` — التشارت المشترك (تاج واحد)
بيدير **مودين**: Real-time و Historical. (نظام modal بيتفتح فوق أي صفحة).

**إعدادات أساسية:**
| الثابت | القيمة | الدور |
|--------|--------|-------|
| `CHART_CONFIG.maxDataPoints` | 60 | عدد نقط الـ real-time المعروضة |
| `CHART_CONFIG.updateInterval` | 1000ms | إيقاع رسم الـ real-time |
| `MAX_DISPLAY_POINTS` | 3000 | الحد الأقصى للنقط المرسومة (LTTB) |
| `EXPORT_XLSX_MAX_ROWS` | 1,048,575 | حد صفوف تصدير الإكسل |

**Real-time:**
| الدالة | الدور |
|--------|-------|
| `updateChartData(field, value)` | بيخزّن **آخر قيمة** بس (مش بيرسم) |
| `startRealtimeSampler()` | يرسم نقطة كل `updateInterval` من آخر قيمة (إيقاع ثابت) |
| `stopRealtimeSampler()` | يوقف المؤقت |
| `setRealtimeInterval(ms)` | يغيّر إيقاع الرسم وقت التشغيل (`ChartSystem.setRealtimeInterval`) |

**Historical:**
| الدالة | الدور |
|--------|-------|
| `initializeTimeline()` | يقرأ المدة من الـ inputs، يضبط `fullRange`/`viewport`، يستدعي التحميل |
| `loadHistoricalData()` | **يمسح الكاش القديم**، يجيب **كل** الخام للفترة مرة واحدة (binary، `format=bin`)، يخزّنه أرقام في الرام |
| `calculateResolution()` | يحسب label للدقة (عرض فقط) |
| `lowerBound/upperBound` | binary search لتحديد الجزء الظاهر في الذاكرة |
| `decimateForDisplay()` | **LTTB** — يقلّل الجزء الظاهر لـ ≤3000 نقطة مع الحفاظ على الشكل |
| `updateViewportFromFullData()` | يقصّ الجزء الظاهر + LTTB + يرسم (خط رفيع، بدون fill/نقط) |
| `handleCustomWheelZoom()` | زووم بالـ scroll (محلي من الكاش) |
| `setupLeftClickPan()` | تحريك بالسحب (محلي) |
| `closeChartModal()` | **يمسح الكاش** (real-time + historical) ويوقف المؤقت |
| `exportToXLSX/exportToCSV/computeStats` | التصدير (مع حماية من الأحجام الكبيرة) |

**تدفّق الـ historical:** Load Data → تحميل واحد لكل الخام في الرام → كل زووم/تحريك = حساب محلي (مفيش طلبات إضافية للسيرفر).

### 7.2 `web/js/multitrend.js` — Multi-Trend اللحظي
صفحة مستقلة بترسم عدة تاجات لحظياً مع بعض.
| الدالة | الدور |
|--------|-------|
| `connect()` | Socket.IO + `tag_updates` يحدّث `valueCache` |
| `buildTree/renderTree/ensureLeaves` | شجرة التاجات (Inverters/EM/WS/PR) |
| `addTag/removeTag/toggleTag` | اختيار التاجات (حد أقصى MAX_TAGS) + الاشتراك per-prefix |
| `startSampling()/sample()` | **sampler** يرسم نقطة كل `SAMPLE_MS`(1s) من `valueCache` (إيقاع ثابت) |
| `isStale()` | لو الجهاز وقف تحديث → يكسر الخط (gap) بدل التجميد |
| `teardown()` | يمسح الكاش ويوقف كله عند إغلاق الصفحة |

### 7.3 `web/js/multitrend_history.js` — Multi-Trend التاريخي (الجديد)
نفس شجرة الـ multitrend بس **للهيستوريكال** — يرسم عدة تاجات تاريخية فوق بعض.
| الدالة | الدور |
|--------|-------|
| `buildTree/...` | نفس شجرة التاجات |
| `addTag/removeTag` | اختيار حتى `MAX_TAGS`(5، قابل للتغيير) + لون لكل تاج |
| `loadData()` | **يجيب كل تاج بالتتابع** (API منفصل لكل واحد، مش مع بعض)؛ اللي يفشل يتبلّغ بالاسم؛ بعدين يرسمهم مع بعض |
| `fetchHistory(tagId, start, end, signal)` | يجيب تاج واحد binary (مع JSON fallback) + AbortController |
| `lttb()` | LTTB لكل تاج (يرجّع `{x,y}`) |
| `buildDatasets()` | يبني dataset لكل تاج (محور **linear x/y** عشان الأزمنة مختلفة) مع `hidden` محفوظ |
| `rebuildChart/refreshChart` | رسم/إعادة رسم؛ زووم/تحريك محلي |
| `onWheel/onCanvasDown/onNavMove` | زووم + تحريك + سحب صندوق الـ navigator |
| `snapshot()` | حفظ صورة PNG للتشارت الحالي |
| `teardown()` | عند إغلاق/تغيير الصفحة: **يلغي التحميل الجاري (AbortController)** ويمسح الكاش |

**نقطة معمارية:** عشان كل تاج له timestamps مختلفة، الصفحة دي بتستخدم محور **linear (x=epoch ms, y=value)** بدل الـ category labels — عشان تقدر تركّب خطوط بأزمنة مختلفة صح.

---

## 8. ملخص الـ "ليه" (قرارات التصميم)

| القرار | السبب |
|--------|-------|
| فصل UI server (:5000) عن Historian (:3000) | فصل المسؤوليات: اللحظي شيء والتخزين شيء |
| Socket.IO للّحظي + HTTP للهيستوري | اللحظي push، الهيستوري request/response |
| Deadband + full refresh | تقليل حجم البثّ والـ CPU |
| تحميل كل الخام مرة واحدة + زووم محلي | سرعة تفاعل عالية، مفيش طلب لكل زووم |
| Binary transport للهيستوري | ~4× أصغر + بدون JSON.parse → ملايين النقط |
| LTTB decimation | خط نضيف يحاكي الشكل بدون ما يجمّد المتصفح |
| جلب الـ multi-trend بالتتابع | عشان تعرف أي تاج فشل، وتقليل الضغط اللحظي |

---

*لتفاصيل المشاكل اللي قابلتنا وحلولها، شوف [PROBLEMS_AND_SOLUTIONS.md](./PROBLEMS_AND_SOLUTIONS.md).*
