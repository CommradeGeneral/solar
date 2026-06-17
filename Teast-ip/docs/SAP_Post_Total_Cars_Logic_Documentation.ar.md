# SAP Total Cars Posting Integration - Logic Documentation (Arabic)

## نبذة سريعة عن الدوكيومنت

الدوكيومنت ده بيشرح **بأسلوب بسيط** منطق سكريبت الـ Integration اللي بياخد بيانات إنتاج العربيات من **SQL Server** ويبعتها إلى **SAP** على مرحلتين (Primary ثم Secondary).

هتلاقي هنا:

- السكريبت بيختار “عربية واحدة” في كل مرة (one-by-one).
- إيه هي الجداول اللي بيتعامل معاها، وإيه مصدر الـ payload.
- إمتى يبعت `Primary` وإمتى يبعت `Secondary` بس.
- إمتى يعتبر العملية نجحت، وإمتى يوقف ويحط السطر في `SAPPostReviewRequired = 1` للمراجعة اليدوية.
- سياسة الـ Retry وليه السكريبت بيتجنب إعادة إرسال الـ POST تلقائيًا في حالات معينة علشان مايحصلش duplication في SAP.

ملاحظة مهمة: المصطلحات الفنية (أسماء الجداول/الأعمدة/الـ API/الـ status) متسيبة **بالإنجليزي** زي ما هي، ومكتوبة غالبًا داخل `backticks` علشان تبقى واضحة.

---

## 1. Purpose

السكريبت ده بيعمل posting لبيانات إنتاج العربيات (concrete production car data) من **SQL Server** إلى **SAP** على خطوتين:

1. **Primary SAP confirmation POST** إلى:
   `API_PROC_ORDER_CONFIRMATION_2_SRV/ProcOrdConf2`
2. **Secondary custom POST** إلى:
   `YY1_API_PROCORDCONF_CUSTOM_CDS/YY1_API_PROCORDCONF_CUSTOM`

السكريبت بيشتغل على العربيات **واحدة واحدة** (one by one). يعني مابيعملش إرسال لأكثر من عربية في نفس SAP request.

---

## 2. Main tables

### 2.1 Source queue table

`dbo.batches_sap_totalCar`

ده جدول الـ queue الأساسي. كل row فيه بيمثل عربية واحدة بعد ما الـ DB trigger يعمل aggregation.

### 2.2 Original batch table

`dbo.Batches_SAP`

السكريبت بيستخدمه في:

- التأكد إن `batches_sap_totalCar.batchNumber` يساوي `MAX(Batches_SAP.batchNumber)` لنفس `orderNumber + carCounter`.
- إعادة بناء/تجميع الـ payload (rebuild/aggregate) **فقط** لو فحص الـ batch number فشل.
- تحديث كل الـ rows الأصلية علشان traceability بعد نتيجة الـ Primary/Secondary.

### 2.3 SAP component table

`dbo.SAP_ProcessOrderComponent`

السكريبت بيستخدمه عشان يجيب:

- `StorageLocation`
- `Reservation`
- `ReservationItem`

وبيرتب raw material lines على حسب `ReservationItem` قبل الإرسال.

---

## 3. Database columns added

الأعمدة دي مضافة في الاتنين:

- `dbo.batches_sap_totalCar`
- `dbo.Batches_SAP`

### 3.1 Columns from SAP primary confirmation response

| Column | Source | Usage |
|---|---|---|
| `SAPConfirmationGroup` | `d.ConfirmationGroup` | Required for secondary POST |
| `SAPConfirmationCount` | `d.ConfirmationCount` | Required for secondary POST |
| `SAPConfirmationMessage` | SAP `sap-message` header | Audit/troubleshooting |
| `SAPConfirmationStatusCode` | HTTP status code | Audit/troubleshooting |
| `SAPConfirmationAt` | Current local time from script | Timestamp of confirmed primary success |
| `SAPIsFinalConfirmation` | `d.IsFinalConfirmation` | Used to decide whether secondary is skipped |

### 3.2 Columns used by the script

| Column | Usage |
|---|---|
| `secondary_readbySAP` | `1` معناها إن خطوة الـ secondary خلصت أو اتخطت intentionally لأن SAP رجّعت final confirmation |
| `SAPPostStatus` | حالة الـ integration الحالية |
| `SAPPostReviewRequired` | `1` معناها محتاج مراجعة/تسوية يدوية؛ السطر مش هيتم اختياره تلقائيًا |
| `SAPPostInProgress` | Runtime lock أثناء معالجة العربية |
| `SAPPostLockId` | GUID للـ run اللي عمل claim للسطر |
| `SAPPostLockedAt` | وقت عمل الـ lock |
| `SAPPostAttemptCount` | عدد مرات المحاولة |
| `SAPLastError` | آخر error summary |
| `SAPLastErrorAt` | وقت آخر error |

---

## 4. Row selection logic

السكريبت بيعمل claim لعربية واحدة فقط في كل مرة من `dbo.batches_sap_totalCar`.

الـ row يبقى eligible لو الشرط ده متحقق:

```sql
ISNULL(SAPPostInProgress, 0) = 0
AND ISNULL(SAPPostReviewRequired, 0) = 0
AND
(
    ISNULL(readbySAP, 0) = 0
    OR
    (
        ISNULL(readbySAP, 0) = 1
        AND ISNULL(secondary_readbySAP, 0) = 0
        AND SAPConfirmationGroup IS NOT NULL
        AND SAPConfirmationCount IS NOT NULL
    )
)
```

### Meaning

| Case | Action |
|---|---|
| `readbySAP = 0` | يبعت الـ primary confirmation الأول |
| `readbySAP = 1`, `secondary_readbySAP = 0`, و `group/count` موجودين | مابيكررش primary؛ يبعت secondary بس |
| `readbySAP = 1`, `secondary_readbySAP = 1` | مابيترسلش تاني نهائيًا |
| `SAPPostReviewRequired = 1` | مابيترسلش تلقائيًا؛ لازم manual review |

---

## 5. Batch number check and payload source

السكريبت دايمًا بيعمل check:

```text
batches_sap_totalCar.batchNumber == MAX(Batches_SAP.batchNumber)
```

لنفس:

```text
orderNumber + carCounter
```

### If the batch number matches

الـ payload بيتبني مباشرةً من:

```text
dbo.batches_sap_totalCar
```

### If the batch number does not match

السكريبت بيعمل log warning وبيبني الـ payload عن طريق تجميع (aggregating) الـ rows الأصلية من:

```text
dbo.Batches_SAP
```

باستخدام نفس `orderNumber + carCounter`.

المهم: عدم التطابق ده **مش بيوقف** عملية posting.

---

## 6. Primary payload logic

الـ primary payload بيتبعت إلى:

```text
API_PROC_ORDER_CONFIRMATION_2_SRV/ProcOrdConf2
```

أهم الـ fields:

| SAP field | Source |
|---|---|
| `OrderID` | `orderNumber` |
| `OrderOperation` | ثابت `0020` |
| `PostingDate` | SQL `[date] + [Time]` بعد تحويلها لصيغة SAP `/Date(...) /` |
| `ConfirmationYieldQuantity` | `actualMeters` أو المجموع بعد aggregation |
| `ConfirmationUnit` | ثابت `M3` |
| `ConfirmationText` | نص ثابت موجود في الكود |

`Material document items`:

1. أول item: finished product receipt، movement type `101`.
2. باقي items (raw materials): movement type `261`، وبالترتيب حسب `ReservationItem`.

---

## 7. Secondary payload logic

الـ secondary payload بيتبعت إلى:

```text
YY1_API_PROCORDCONF_CUSTOM_CDS/YY1_API_PROCORDCONF_CUSTOM
```

الـ fields:

| SAP field | Source |
|---|---|
| `ConfirmationGroup` | Primary response `ConfirmationGroup` |
| `ConfirmationCount` | Primary response `ConfirmationCount` |
| `OrderID` | `orderNumber` |
| `DriverID` | `driver_id` |
| `DriverName` | `driver_Name` |
| `PumpID` | `pump_id` |
| `VehicleID` | `car_id` |
| `CarPlateNumber` | `car_id` |

---

## 8. Success logic

### 8.1 Primary success

الـ primary يعتبر نجح لما يتحقق الآتي:

- HTTP status `200` أو `201`.
- `ConfirmationGroup` موجود.
- `ConfirmationCount` موجود.
- الـ `OrderID` اللي راجع يساوي `OrderID` اللي اتبعت في الـ payload.
- `IsReversed = false`.
- `IsReversal = false`.
- مفيش SAP message severity من نوع error/abort.
- الكمية matches لما القيمتين ينفع يتحولوا لـ decimals.

لو الـ primary نجح، السكريبت بيكتب:

```text
readbySAP = 1
SAPConfirmationGroup = returned group
SAPConfirmationCount = returned count
SAPConfirmationMessage = SAP message
SAPConfirmationStatusCode = HTTP status
SAPConfirmationAt = current time
SAPIsFinalConfirmation = returned IsFinalConfirmation
```

### 8.2 If `IsFinalConfirmation = true`

السكريبت فورًا بيعمل:

```text
readbySAP = 1
secondary_readbySAP = 1
SAPPostStatus = COMPLETED_FINAL_SECONDARY_SKIPPED
```

وبالتالي **مش** بيبعت secondary POST.

ده بيضمن إن العربية/الأوردر مش هيتختاروا تاني.

### 8.3 If `IsFinalConfirmation = false`

السكريبت بيعمل:

```text
readbySAP = 1
SAPPostStatus = PRIMARY_CONFIRMED_SECONDARY_PENDING
```

وبعدين يبعت الـ secondary POST.

لو الـ secondary نجح:

```text
secondary_readbySAP = 1
SAPPostStatus = COMPLETED_SECONDARY_CONFIRMED
```

---

## 9. Failure and error handling

الفكرة الأساسية هنا: بعض الأخطاء “غير مؤكدة” (uncertain) زي timeout/connection error. في الحالات دي السكريبت بيتجنب أي retry تلقائي للـ POST علشان مايحصلش duplicate confirmation في SAP.

### 9.1 Primary timeout

Status:

```text
PRIMARY_UNCERTAIN_TIMEOUT
```

Actions:

```text
readbySAP remains 0
secondary_readbySAP remains unchanged/0
SAPPostReviewRequired = 1
SAPPostInProgress = 0
SAPLastError is filled
```

Reason:

الـ timeout معناه “مش متأكدين”. ممكن SAP يكون استلم وعمل posting، بس السكريبت ماستلمش response. لذلك ممنوع retry تلقائيًا لتجنب duplication.

### 9.2 Primary connection error

Status:

```text
PRIMARY_UNCERTAIN_CONNECTION_ERROR
```

نفس الـ actions بتاعت timeout.

### 9.3 Primary SAP business error

Status:

```text
PRIMARY_SAP_BUSINESS_ERROR
```

Actions:

```text
readbySAP remains 0
secondary is not sent
SAPPostReviewRequired = 1
SAPLastError is filled
```

Example causes:

- invalid reservation.
- invalid material.
- invalid quantity.
- SAP رجّع OData error body.
- SAP message severity كانت `error` أو `abort`.

### 9.4 Primary HTTP error

Status:

```text
PRIMARY_HTTP_ERROR
```

Actions:

```text
readbySAP remains 0
secondary is not sent
SAPPostReviewRequired = 1
SAPLastError is filled
```

Example statuses:

- `401`
- `403`
- `404`
- `500`

### 9.5 Secondary timeout

Status:

```text
SECONDARY_UNCERTAIN_TIMEOUT
```

Actions:

```text
readbySAP remains 1
secondary_readbySAP remains 0
SAPPostReviewRequired = 1
SAPLastError is filled
```

الـ primary مش بيتكرر في الـ run اللي بعده. لازم manual review.

### 9.6 Secondary connection error

Status:

```text
SECONDARY_UNCERTAIN_CONNECTION_ERROR
```

نفس handling بتاع secondary timeout.

### 9.7 Secondary SAP business error

Status:

```text
SECONDARY_SAP_BUSINESS_ERROR
```

Actions:

```text
readbySAP remains 1
secondary_readbySAP remains 0
SAPPostReviewRequired = 1
SAPLastError is filled
```

الـ primary مش بيتكرر.

### 9.8 Secondary HTTP error

Status:

```text
SECONDARY_HTTP_ERROR
```

Actions:

```text
readbySAP remains 1
secondary_readbySAP remains 0
SAPPostReviewRequired = 1
SAPLastError is filled
```

---

## 10. Retry policy

### Safe retries

السكريبت بيعيد محاولة fetch للـ CSRF token لأنه request آمن (safe GET).

### POST retries

السكريبت **مابيعملش** retry تلقائي للـ POST بعد timeout أو connection error.

الـ POST retry الوحيد: لو SAP رجّع CSRF validation failure بشكل واضح. وقتها السكريبت بيجيب CSRF token جديد وبيعيد نفس الـ POST مرة واحدة، لأن SAP رفضت الطلب قبل ما تعالجه.

---

## 11. Manual review

أي rows عليها:

```text
SAPPostReviewRequired = 1
```

بتتستبعد من الـ automatic selection.

قبل ما تعمل reset، راجع SAP يدويًا باستخدام:

- `orderNumber`
- `carCounter`
- `SAPConfirmationGroup`
- `SAPConfirmationCount`
- logs

لو safe إنك تعيد secondary فقط، امسح/صفر:

```sql
SAPPostReviewRequired = 0,
SAPPostInProgress = 0
```

ممنوع تمسح primary timeout row من غير ما تتأكد الأول إن SAP ماعملتش confirmation بالفعل.

