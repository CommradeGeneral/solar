### في البدايه  نبذة عن الـ  Documentation

ال Documentation دي بتشرح الIntegration بين ال SQL Server و SAP في عمليه انتاج الخرسانه
والسيستم ده بيهدف الي
ارسال بيانات العربيات اللي تم تحميلها بالخرسانة الي السيستم بشكل امن ومنظم وبدون تكرار البيانات وذلك انه بيسجل بطريقه **one by one**
اي بيسجل عربيه بعربيه

### وده بيتم من خلال مرحلتين وهما

1. **Primary SAP confirmation POST** :
   `API_PROC_ORDER_CONFIRMATION_2_SRV/ProcOrdConf2`
2. **Secondary custom POST** :
   `YY1_API_PROCORDCONF_CUSTOM_CDS/YY1_API_PROCORDCONF_CUSTOM`

 ### اولا ال **Primary SAP confirmation POST** :
في المرحله دي بيتم اراسال البيانات الخاصه بالخرسانه نفسها مثل الرمل والاسمنت وغيرها 
ولا يتم النقل الي مرحله ال**Secondary custom POST**  الا بعد الانتهاء من مرحله ال**Primary SAP** 

 ### وظيفة ال API دي:     `API_PROC_ORDER_CONFIRMATION_2_SRV/ProcOrdConf2`

- تأكيد تنفيذ الـ Production Order
- تسجيل الكمية المنتجة
- تسجيل استهلاك المواد الخام
- تنفيذ Goods Movement داخل SAP

 ### ثانيا ال **Secondary custom POST** : 
بعد نجاح الـ Primary Confirmation يتم إرسال بيانات إضافية باستخدام الـ API التالية:

### وظيفة الـ API دي: `YY1_API_PROCORDCONF_CUSTOM_CDS/YY1_API_PROCORDCONF_CUSTOM`

- ربط الـ Confirmation ببيانات التشغيل الفعلية

- إرسال بيانات العربية والسائق وغيرها من البيانات الزائده

 ### طيب اي هي اهم الجداول الموجوده:
### Source queue table

`dbo.batches_sap_totalCar`
الجدول ده عبارة عن Aggregated Data تم تجميعها من البيانات الأصلية عن طريق Database Trigger.

### وظيفة الجدول

- يحتوي على بيانات العربية بشكل مجمع
- يستخدمه الـ Integration Script أثناء الـ Posting

### Original batch table

`dbo.Batches_SAP`

السكريبت بيستخدمه في:

- التأكد إن `batches_sap_totalCar.batchNumber` يساوي `MAX(Batches_SAP.batchNumber)` لنفس `orderNumber + carCounter`. 
وطبعا ده اهميته انه يتاكد انه بيجيب احدث البيانات يعني لو في تاخير في الداتا يرجع يحسبها تاني بحيث انه يجيب احدث البيانات للعربيه الواحده بدون تاخير او تكرار 

- إعادة بناء/تجميع الـ payload (rebuild/aggregate) **فقط** لو فحص الـ batch number فشل.
- تحديث كل الـ rows الأصلية علشان traceability بعد نتيجة الـ Primary/Secondary.
##  Traceability ومعني ال 

يتم تحديث الـ Original Rows بنتائج الـ Primary و Secondary Posting للحفاظ على الـ Audit Trail.

### SAP component table

`dbo.SAP_ProcessOrderComponent`

السكريبت بيستخدمه عشان يجيب:

- `StorageLocation`
- `Reservation`
- `ReservationItem`

وبيرتب raw material lines على حسب `ReservationItem` قبل الإرسال.

## دلوقتي دي Database columns added

الأعمدة دي مضافة في الاتنين:

- `dbo.batches_sap_totalCar`
- `dbo.Batches_SAP`

### اولا: Columns from SAP primary confirmation response

| Column | Source | Usage |
|---|---|---|
| `SAPConfirmationGroup` | `d.ConfirmationGroup` | Required for secondary POST |
| `SAPConfirmationCount` | `d.ConfirmationCount` | Required for secondary POST |
| `SAPConfirmationMessage` | SAP `sap-message` header | Audit/troubleshooting |
| `SAPConfirmationStatusCode` | HTTP status code | Audit/troubleshooting |
| `SAPConfirmationAt` | Current local time from script | Timestamp of confirmed primary success |
| `SAPIsFinalConfirmation` | `d.IsFinalConfirmation` | Used to decide whether secondary is skipped |
 
### شرح كل عمود

## SAPConfirmationGroup
يحتوي على رقم الـ Confirmation الذي تم إنشاؤه داخل SAP.
يستخدم لاحقًا أثناء الـ Secondary POST.
---

## SAPConfirmationCount

يمثل الـ Counter الخاص بالـ Confirmation داخل SAP.
يستخدم مع: SAPConfirmationGroup
لتحديد الـ Confirmation بشكل Unique.
---

## SAPConfirmationMessage
يحتوي على الـ Message الراجعة من SAP.
مثال:
Confirmation saved successfully
وده بيساعده فال
- Audit
- Troubleshooting
- Logs
---

## SAPConfirmationStatusCode
يحتوي على HTTP Status Code الخاص بالـ Response.
أمثلة:
| Status Code | المعنى |
|---|---|
| 200 | Success |
| 201 | Created |
| 401 | Unauthorized |
| 500 | Internal Server Error |
---

## SAPConfirmationAt
وقت نجاح الـ Primary Confirmation.
يستخدم في:
- Monitoring
- Audit
- Tracking
---

## SAPIsFinalConfirmation
يوضح إذا كان SAP اعتبر الـ Production Order Final Confirmation أم لا.


### ثانيا  Columns used by the script

| `secondary_readbySAP` |
| `SAPPostStatus` |
| `SAPPostReviewRequired` |
| `SAPPostInProgress` |
| `SAPPostLockId` |
| `SAPPostLockedAt` |
| `SAPPostAttemptCount` |
| `SAPLastError` |
| `SAPLastErrorAt` |

---
### شرح كل عمود

## secondary_readbySAP
إذا كانت القيمة: 1
فهذا يعني:
- الـ Secondary POST اكتملت
أو
- تم تخطيها بسبب Final Confirmation
---

## SAPPostStatus
يحتوي على الحالة الحالية للـ Integration.
أمثلة:
PRIMARY_CONFIRMED_SECONDARY_PENDING
```
SECONDARY_HTTP_ERROR
```
---

## SAPPostReviewRequired
إذا كانت القيمة: 1
فهذا يعني أن الـ Row تحتاج Manual Review.
الـ Script لن يختار الـ Row تلقائيًا.
---

## SAPPostInProgress
يستخدم كـ Runtime Lock أثناء معالجة العربية.
يمنع أكثر من Process من معالجة نفس العربية في نفس الوقت.
---

## SAPPostLockId
يحتوي على GUID يحدد الـ Script Run الذي قام بحجز الـ Row.
---

## SAPPostLockedAt
وقت إنشاء الـ Lock.
---

## SAPPostAttemptCount
عدد محاولات معالجة الـ Row.
---

## SAPLastError
يحتوي على آخر Error حدث أثناء المعالجة.
---

## SAPLastErrorAt
وقت آخر Error.
---

