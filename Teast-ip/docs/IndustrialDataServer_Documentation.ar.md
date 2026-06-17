# توثيق مشروع: Industrial Data Server

## 1) نظرة عامة
مشروع Node.js يعمل كسيرفر **Alarms + Historian** للبيانات الصناعية مع دعم:
- Siemens S7 عبر `node-snap7`
- Modbus TCP/RTU عبر `modbus-serial`
- REST API + WebSocket
- تخزين (States) للإنذارات على ملف JSON (للاستمرارية بعد الريستارت)
- SQL Server كمخزن بيانات رئيسي (Tags/History/Logs/Metrics)

نقطة التشغيل: `src/index.js`

## 2) تشغيل المشروع (High level)
- تشغيل مباشر: `node src/index.js`
- Docker: `docker-compose.yml` (SQL Server + السيرفر)

ملاحظة: هذا الريبو لا يحتوي `node_modules/`، فلازم تثبيت الاعتمادات قبل التشغيل عبر `npm install` (قد تحتاج تفعيل PowerShell execution policy لتشغيل npm).

## 3) ملف التعريف (config.ini)
هذا الملف هو المصدر الأساسي للإعدادات، ويمكن تحديد مساره عبر env: `CONFIG_PATH`.

### [General]
- `ServiceName` = `IndustrialDataServer`
- `LogLevel` = `INFO`
- `LogPath` = `./logs`
- `MaxLogSizeMB` = `10`
- `MaxLogFiles` = `5`
- `EnableDatabaseLogging` = `true`
- `StateFilePath` = `./data/last_alarm_states.json`
- `ReloadFlagPath` = `./data/reload_flag.txt`
- `EnableDesktopNotifications` = `false`
- `ConnectionStatusLogIntervalMs` = `60000`

### [Database]
- `Server` = `localhost`
- `Database` = `IndustrialDB`
- `Driver` = `ODBC Driver 18 for SQL Server`
- `UseWindowsAuth` = `true`
- `PoolMin` = `2`
- `PoolMax` = `10`
- `ConnectionTimeout` = `30000`
- `RequestTimeout` = `60000`
- `MaxRetries` = `3`
- `RetryDelayMs` = `5000`
- `Encrypt` = `false`
- `TrustServerCertificate` = `true`

### [PLC]
- `ConnectionTimeoutMs` = `5000`
- `ReadTimeoutMs` = `3000`
- `AutoReconnect` = `true`
- `ReconnectIntervalMs` = `10000`
- `MaxReconnectAttempts` = `0`

### [Modbus]
- `ConnectionTimeoutMs` = `5000`
- `ReadTimeoutMs` = `3000`
- `AutoReconnect` = `false`
- `ReconnectIntervalMs` = `10000`

### [AlarmService]
- `Enabled` = `true`
- `ScanIntervalMs` = `1000`
- `ConsecutiveTrueCount` = `3`
- `ConsecutiveFalseCount` = `3`
- `ChatterFilterMs` = `1000`
- `BatchSize` = `50`
- `BufferSize` = `3000`
- `ThreadPoolSize` = `2`

### [HistorianService]
- `Enabled` = `true`
- `BatchSize` = `100`
- `FlushIntervalMs` = `5000`
- `BufferSize` = `10000`
- `ThreadPoolSize` = `2`
- `DefaultQuality` = `192`

### [Retention]
- `Enabled` = `false`
- `RunIntervalMs` = `21600000`
- `InitialDelayMs` = `60000`
- `HistorianDays` = `30`
- `AlarmDays` = `90`
- `SystemLogsDays` = `14`
- `MetricsDays` = `14`
- `BatchSize` = `10000`
- `PauseMs` = `100`
- `MaxRunMs` = `600000`

### [ExcelDevices]
- `Enabled` = `false`
- `Files` = `./excel-data/Analog_Alarm.xlsx,./excel-data/Discrete_Alarm.xlsx,./excel-data/History.xlsx`
- `PollIntervalMs` = `10000`

### [API]
- `Enabled` = `true`
- `Port` = `3000`
- `Host` = `0.0.0.0`
- `EnableCors` = `true`
- `CorsOrigins` = `*`
- `RateLimitPerMinute` = `1000`
- `JwtSecret` = `your-super-secret-jwt-key-change-this`
- `JwtExpirationHours` = `24`

### [WebSocket]
- `Enabled` = `true`
- `Path` = `/ws`
- `HeartbeatIntervalMs` = `30000`
- `ClientTimeoutMs` = `60000`
- `MaxClients` = `100`

### [Metrics]
- `Enabled` = `true`
- `CollectionIntervalMs` = `60000`
- `EnablePrometheus` = `true`
- `PrometheusPath` = `/metrics`


## 4) ملفات Excel المستخدمة (مصادر Tags/Devices)
يوجد فولدر `excel-data/` وفيه 3 ملفات رئيسية. **الأعمدة بالأسفل مأخوذة من Row 1 داخل كل Sheet**:

### ملف: `excel-data/Analog_Alarm.xlsx`
- Sheet: **PLCs**
  - الأعمدة (Header row): `plc_id`, `plc_name`, `ip_address`, `rack`, `slot`, `description`
  - أمثلة: (لا توجد بيانات واضحة)
- Sheet: **ModbusDevices**
  - الأعمدة (Header row): `device_id`, `device_name`, `ip_address`, `port`, `unit_id`, `connection_type`, `serial_port`, `baud_rate`, `description`
  - أمثلة: (لا توجد بيانات واضحة)
- Sheet: **Tags**
  - الأعمدة (Header row): `ID`, `name`, `protocol_type`, `plc_id`, `db_number`, `offset`, `bit`, `modbus_device_id`, `register_type`, `modbus_address`, `register_count`, `data_type`, `equation`, `Limit Value`, `Limit Mode`, `lilmit is editable`, `class`, `number`, `alarm type`, `alarm text`, `alarm tooltip`, `Additional Text 1`, `Additional Text 2`
  - أمثلة: (لا توجد بيانات واضحة)

### ملف: `excel-data/Discrete_Alarm.xlsx`
- Sheet: **PLCs**
  - الأعمدة (Header row): `plc_id`, `plc_name`, `ip_address`, `rack`, `slot`, `description`
  - أمثلة (أول 3 صفوف بيانات):
    - `PLC1` | `PlcBridge` | `192.168.1.188` | `0` | `2` | `PlcBridge`
- Sheet: **ModbusDevices**
  - الأعمدة (Header row): `device_id`, `device_name`, `ip_address`, `port`, `unit_id`, `connection_type`, `serial_port`, `baud_rate`, `description`
  - أمثلة: (لا توجد بيانات واضحة)
- Sheet: **Tags**
  - الأعمدة (Header row): `ID`, `tag_name`, `protocol_type`, `plc_id`, `db_number`, `byte_offset`, `bit_offset`, `modbus_device_id`, `register_type`, `modbus_address`, `register_count`, `data_type`, `equation`, `Limit Mode`, `alarm_text`, `alarm_tooltip`, `alarm_class`, `alarm_number`, `alarm_type`
  - أمثلة (أول 3 صفوف بيانات):
    - `1` | `Generator diesel engine - Control box power failure` | `snap7` | `PLC1` | `4` | `0` | `0` | `Bool` | `High` | `Generator diesel engine - Control box power failure` | `Discrete Alarm_1` | `Generator` | `1` | `alarm`
    - `2` | `Generator diesel engine - Seawater cooling water temperature is high` | `snap7` | `PLC1` | `4` | `0` | `1` | `Bool` | `High` | `Generator diesel engine - Seawater cooling water temperature is high` | `Discrete Alarm_2` | `Generator` | `2` | `waraning`
    - `3` | `Generator diesel engine - Seawater cooling water temperature is too high` | `snap7` | `PLC1` | `4` | `0` | `2` | `Bool` | `High` | `Generator diesel engine - Seawater cooling water temperature is too high` | `Discrete Alarm_3` | `Generator` | `3` | `alarm`

### ملف: `excel-data/History.xlsx`
- Sheet: **PLCs**
  - الأعمدة (Header row): `plc_id`, `plc_name`, `ip_address`, `rack`, `slot`, `description`
  - أمثلة (أول 3 صفوف بيانات):
    - `PLC1` | `PlcAms` | `192.168.1.188` | `0` | `2` | `PlcAms`
    - `PLC2` | `PlcBridge` | `192.168.1.88` | `0` | `2` | `PlcBridge`
- Sheet: **ModbusDevices**
  - الأعمدة (Header row): `device_id`, `device_name`, `ip_address`, `port`, `unit_id`, `connection_type`, `serial_port`, `baud_rate`, `description`
  - أمثلة: (لا توجد بيانات واضحة)
- Sheet: **Tags**
  - الأعمدة (Header row): `tag_id`, `tag_name`, `protocol_type`, `plc_id`, `db_number`, `offset`, `bit`, `modbus_device_id`, `register_type`, `modbus_address`, `register_count`, `data_type`, `equation`, `description`, `reading_cycles`, `deadband`, `deadband_check_cycle_s`
  - أمثلة (أول 3 صفوف بيانات):
    - `1` | `CL_TURB_A_RPM_G1` | `snap7` | `PLC1` | `3` | `46` | `int` | `CL_TURB_A_RPM_G1` | `1 min`
    - `2` | `CL_GEN_RPM_G1` | `snap7` | `PLC1` | `3` | `44` | `int` | `CL_GEN_RPM_G1` | `1 min`
    - `3` | `CL_TURB_B_RPM_G1` | `snap7` | `PLC1` | `3` | `48` | `int` | `CL_TURB_B_RPM_G1` | `1 min`

### ملاحظة مهمة عن Excel
- الاستيراد الفعلي للـ Tags/Devices من Excel يتم عبر `tools/import-excel.js` ويعتمد على أسماء Sheets معيّنة (مثل: `Tags`, `PLCs`, `ModbusDevices`).
- في التشغيل العادي، السيرفر يقرأ الـ Tags من قاعدة البيانات عبر Stored Procedures، وميزة `ExcelDevices.Enabled=true` تُستخدم فقط لتحميل **تعريف الأجهزة (PLCs/Modbus)** من Excel ومتابعة التغييرات (Watcher).

## 4.1) شرح أعمدة Excel (المتوقع استخدامها)
### Sheets: PLCs / PLC
- `plc_id`: معرف فريد للـ PLC (مستخدم كـ PK في جدول `PLCs`).
- `plc_name`: اسم وصفي للـ PLC.
- `ip_address`: عنوان IP للـ PLC.
- `rack`: Rack (عادة 0).
- `slot`: Slot (عادة 1 أو 2 حسب CPU).
- `description`: وصف إضافي.

### Sheets: ModbusDevices / Modbus
- `device_id`: معرف فريد للجهاز (PK في `ModbusDevices`).
- `device_name`: اسم وصفي للجهاز.
- `connection_type`: `tcp` أو `rtu`.
- `ip_address`: عنوان IP (مطلوب في tcp).
- `port`: بورت Modbus TCP (افتراضي 502).
- `unit_id`: Unit ID / Slave ID.
- `serial_port`: منفذ Serial (مطلوب في rtu) مثل `COM3`.
- `baud_rate`: Baud rate (RTU).
- `parity`, `stop_bits`, `data_bits`: إعدادات RTU.
- `description`: وصف إضافي.

### Sheet: Tags (تختلف حسب الملف)
**حقول تعريف مصدر القراءة (PLC/S7):**
- `protocol_type`: غالبًا `snap7` أو `modbus`.
- `plc_id`: يربط بالـ PLC في جدول `PLCs`.
- `db_number`: رقم DB في S7.
- `byte_offset` / `offset`: البايت offset داخل DB (قد يكون رقم صحيح أو يحتوي float عند استخدام bit).
- `bit_offset` / `bit`: رقم البِت داخل البايت (لـ Bool).

**حقول تعريف مصدر القراءة (Modbus):**
- `modbus_device_id`: يربط بالجهاز في `ModbusDevices`.
- `register_type`: نوع الريجستر (مثل `1x/3x/4x` أو `1x,2x,3x,4x` حسب الملف).
- `modbus_address`: عنوان الريجستر.
- `register_count`: عدد الريجسترات (مثلاً 2 للـ float).

**تحويل البيانات والمعادلات:**
- `data_type`: نوع البيانات (مثل `Bool`, `int`, `uint`, `dint`, `real`...).
- `equation`: معادلة mathjs تستخدم `x` (مثال: `(x/27648)`).

**إنذارات Analog (Analog_Alarm.xlsx):**
- `Limit Value`: قيمة الحد.
- `Limit Mode`: طريقة المقارنة (`Equal`, `Greater`, `Smaller`, ...).
- `limit is editable`: هل الحد قابل للتعديل.
- `class` / `alarm_class`: تصنيف الإنذار.
- `number` / `alarm_number`: رقم الإنذار.
- `alarm type` / `alarm_type`: شدة/نوع الإنذار (`alarm/warning/error`).
- `alarm text` / `alarm_text`: نص الإنذار.
- `alarm tooltip` / `alarm_tooltip`: Tooltip.
- `Additional Text 1/2`: نصوص إضافية.

**إنذارات Discrete (Discrete_Alarm.xlsx):**
- `Limit Mode`: غالبًا `High` أو `Low` (يعامل القيمة كـ boolean).
- باقي حقول النص/التصنيف مشابهة لـ analog.

**Historian (History.xlsx):**
- `description`: وصف التاج.
- `reading_cycles` / `reading_cycle` / `reading_cycle_ms`: دورية القراءة/التسجيل (المنفذ الحقيقي يعتمد على DB/الكود).
- `deadband`: قيمة deadband (0 = يسجل دائمًا).
- `deadband_check_cycle_s`: كل كام ثانية يتم فحص deadband (exception sampling).

## 5) قاعدة البيانات (SQL Server) - الجداول والأعمدة
المصدر: `database/01_create_database.sql`

### جدول: `PLCs`
- **الغرض:** تعريف أجهزة Siemens S7 (عنوان IP + rack/slot) التي يتم الاتصال بها.
| العمود | النوع | القيود/الوصف |
|---|---|---|
| `plc_id` | `NVARCHAR(50)` | PRIMARY KEY |
| `plc_name` | `NVARCHAR(100)` | NOT NULL |
| `ip_address` | `NVARCHAR(50)` | NOT NULL |
| `rack` | `INT` | NOT NULL DEFAULT 0 |
| `slot` | `INT` | NOT NULL DEFAULT 1 |
| `description` | `NVARCHAR(500)` | NULL |
| `is_active` | `BIT` | NOT NULL DEFAULT 1 |
| `created_at` | `DATETIME2` | NOT NULL DEFAULT GETDATE() |
| `updated_at` | `DATETIME2` | NOT NULL DEFAULT GETDATE() |

### جدول: `ModbusDevices`
- **الغرض:** تعريف أجهزة Modbus (TCP/RTU) وباراميترات الاتصال (IP/Port أو Serial).
| العمود | النوع | القيود/الوصف |
|---|---|---|
| `device_id` | `NVARCHAR(50)` | PRIMARY KEY |
| `device_name` | `NVARCHAR(100)` | NOT NULL |
| `ip_address` | `NVARCHAR(50)` | NULL |
| `port` | `INT` | NULL DEFAULT 502 |
| `unit_id` | `INT` | NOT NULL DEFAULT 1 |
| `connection_type` | `NVARCHAR(10)` | NOT NULL DEFAULT 'tcp', -- tcp / rtu |
| `serial_port` | `NVARCHAR(20)` | NULL,  -- COM1, /dev/ttyUSB0 |
| `baud_rate` | `INT` | NULL DEFAULT 9600 |
| `parity` | `NVARCHAR(10)` | NULL DEFAULT 'none' |
| `stop_bits` | `INT` | NULL DEFAULT 1 |
| `data_bits` | `INT` | NULL DEFAULT 8 |
| `description` | `NVARCHAR(500)` | NULL |
| `is_active` | `BIT` | NOT NULL DEFAULT 1 |
| `created_at` | `DATETIME2` | NOT NULL DEFAULT GETDATE() |
| `updated_at` | `DATETIME2` | NOT NULL DEFAULT GETDATE() |

### جدول: `AnalogAlarmTags`
- **الغرض:** تعريف Tags الخاصة بإنذارات Analog (Limit + Mode + مصدر القراءة PLC/Modbus).
| العمود | النوع | القيود/الوصف |
|---|---|---|
| `id` | `INT` | PRIMARY KEY |
| `tag_name` | `NVARCHAR(100)` | NOT NULL |
| `protocol_type` | `NVARCHAR(20)` | NOT NULL, -- snap7 / modbus |
| `plc_id` | `NVARCHAR(50)` | NULL |
| `db_number` | `INT` | NULL |
| `byte_offset` | `FLOAT` | NULL |
| `bit_offset` | `INT` | NULL |
| `modbus_device_id` | `NVARCHAR(50)` | NULL |
| `register_type` | `NVARCHAR(10)` | NULL, -- 1x, 2x, 3x, 4x |
| `modbus_address` | `INT` | NULL |
| `register_count` | `INT` | NULL DEFAULT 1 |
| `data_type` | `NVARCHAR(20)` | NOT NULL, -- int, uint, dint, udint, real, bool |
| `equation` | `NVARCHAR(200)` | NULL, -- e.g. (x/27648) |
| `limit_value` | `FLOAT` | NOT NULL |
| `limit_mode` | `NVARCHAR(20)` | NOT NULL, -- Equal, Greater, Smaller, GreaterOrEqual, SmallerOrEqual |
| `limit_is_editable` | `BIT` | NOT NULL DEFAULT 1 |
| `alarm_class` | `NVARCHAR(50)` | NULL |
| `alarm_number` | `INT` | NULL |
| `alarm_type` | `NVARCHAR(20)` | NOT NULL DEFAULT 'alarm', -- alarm, warning, error |
| `alarm_text` | `NVARCHAR(200)` | NOT NULL |
| `alarm_tooltip` | `NVARCHAR(500)` | NULL |
| `additional_text1` | `NVARCHAR(500)` | NULL |
| `additional_text2` | `NVARCHAR(500)` | NULL |
| `consecutive_true_count` | `INT` | NOT NULL DEFAULT 3 |
| `consecutive_false_count` | `INT` | NOT NULL DEFAULT 3 |
| `chatter_filter_ms` | `INT` | NOT NULL DEFAULT 1000 |
| `is_enabled` | `BIT` | NOT NULL DEFAULT 1 |
| `created_at` | `DATETIME2` | NOT NULL DEFAULT GETDATE() |
| `updated_at` | `DATETIME2` | NOT NULL DEFAULT GETDATE() |

**Constraints / Keys**
- `-- Siemens S7 Fields`
- `-- Modbus Fields`
- `-- Data Processing`
- `-- Alarm Configuration`
- `-- Alarm Metadata`
- `-- Anti-Chatter Settings`
- `-- Status`
- `-- Foreign Keys`
- `CONSTRAINT FK_AnalogAlarm_PLC FOREIGN KEY (plc_id) REFERENCES PLCs(plc_id)`
- `CONSTRAINT FK_AnalogAlarm_Modbus FOREIGN KEY (modbus_device_id) REFERENCES ModbusDevices(device_id)`

### جدول: `DiscreteAlarmTags`
- **الغرض:** تعريف Tags الخاصة بإنذارات Discrete (HIGH/LOW) + مصدر القراءة PLC/Modbus.
| العمود | النوع | القيود/الوصف |
|---|---|---|
| `id` | `INT` | PRIMARY KEY |
| `tag_name` | `NVARCHAR(100)` | NOT NULL |
| `protocol_type` | `NVARCHAR(20)` | NOT NULL, -- snap7 / modbus |
| `plc_id` | `NVARCHAR(50)` | NULL |
| `db_number` | `INT` | NULL |
| `byte_offset` | `FLOAT` | NULL |
| `bit_offset` | `INT` | NULL |
| `modbus_device_id` | `NVARCHAR(50)` | NULL |
| `register_type` | `NVARCHAR(10)` | NULL |
| `modbus_address` | `INT` | NULL |
| `register_count` | `INT` | NULL DEFAULT 1 |
| `data_type` | `NVARCHAR(20)` | NOT NULL DEFAULT 'Bool' |
| `equation` | `NVARCHAR(200)` | NULL |
| `limit_mode` | `NVARCHAR(10)` | NOT NULL DEFAULT 'High', -- High / Low |
| `alarm_class` | `NVARCHAR(50)` | NULL |
| `alarm_number` | `INT` | NULL |
| `alarm_type` | `NVARCHAR(20)` | NOT NULL DEFAULT 'alarm' |
| `alarm_text` | `NVARCHAR(200)` | NOT NULL |
| `alarm_tooltip` | `NVARCHAR(500)` | NULL |
| `consecutive_true_count` | `INT` | NOT NULL DEFAULT 3 |
| `consecutive_false_count` | `INT` | NOT NULL DEFAULT 3 |
| `chatter_filter_ms` | `INT` | NOT NULL DEFAULT 1000 |
| `is_enabled` | `BIT` | NOT NULL DEFAULT 1 |
| `created_at` | `DATETIME2` | NOT NULL DEFAULT GETDATE() |
| `updated_at` | `DATETIME2` | NOT NULL DEFAULT GETDATE() |

**Constraints / Keys**
- `-- Siemens S7 Fields`
- `-- Modbus Fields`
- `-- Data Processing`
- `-- Alarm Configuration`
- `-- Alarm Metadata`
- `-- Anti-Chatter Settings`
- `-- Status`
- `CONSTRAINT FK_DiscreteAlarm_PLC FOREIGN KEY (plc_id) REFERENCES PLCs(plc_id)`
- `CONSTRAINT FK_DiscreteAlarm_Modbus FOREIGN KEY (modbus_device_id) REFERENCES ModbusDevices(device_id)`

### جدول: `HistorianTags`
- **الغرض:** تعريف Tags الخاصة بالـ Historian (الدورية + deadband) + مصدر القراءة PLC/Modbus.
| العمود | النوع | القيود/الوصف |
|---|---|---|
| `tag_id` | `INT` | PRIMARY KEY |
| `tag_name` | `NVARCHAR(100)` | NOT NULL |
| `protocol_type` | `NVARCHAR(20)` | NOT NULL |
| `plc_id` | `NVARCHAR(50)` | NULL |
| `db_number` | `INT` | NULL |
| `byte_offset` | `FLOAT` | NULL |
| `bit_offset` | `INT` | NULL |
| `modbus_device_id` | `NVARCHAR(50)` | NULL |
| `register_type` | `NVARCHAR(10)` | NULL |
| `modbus_address` | `INT` | NULL |
| `register_count` | `INT` | NULL DEFAULT 1 |
| `data_type` | `NVARCHAR(20)` | NOT NULL |
| `equation` | `NVARCHAR(200)` | NULL |
| `description` | `NVARCHAR(500)` | NULL |
| `reading_cycle` | `NVARCHAR(20)` | NOT NULL DEFAULT '1 min', -- 1 sec, 5 sec, 1 min, 5 min, etc. |
| `reading_cycle_ms` | `INT` | NOT NULL DEFAULT 60000 |
| `deadband` | `FLOAT` | NULL DEFAULT 0 |
| `deadband_check_cycle_s` | `INT` | NULL DEFAULT NULL, -- fast check interval in whole seconds (NULL = disabled) |
| `is_enabled` | `BIT` | NOT NULL DEFAULT 1 |
| `created_at` | `DATETIME2` | NOT NULL DEFAULT GETDATE() |
| `updated_at` | `DATETIME2` | NOT NULL DEFAULT GETDATE() |

**Constraints / Keys**
- `-- Siemens S7 Fields`
- `-- Modbus Fields`
- `-- Data Processing`
- `-- Historian Settings`
- `-- Deadband Settings (0 or NULL = disabled, value = ± threshold on processedValue)`
- `-- Status`
- `CONSTRAINT FK_Historian_PLC FOREIGN KEY (plc_id) REFERENCES PLCs(plc_id)`
- `CONSTRAINT FK_Historian_Modbus FOREIGN KEY (modbus_device_id) REFERENCES ModbusDevices(device_id)`

### جدول: `AlarmStates`
- **الغرض:** الحالة الحالية/الـ runtime state لكل إنذار (active/ack/ended...) للاستخدام في API/WebSocket.
| العمود | النوع | القيود/الوصف |
|---|---|---|
| `id` | `INT` | IDENTITY(1,1) PRIMARY KEY |
| `alarm_type` | `NVARCHAR(20)` | NOT NULL, -- analog / discrete |
| `tag_id` | `INT` | NOT NULL |
| `state_code` | `INT` | NOT NULL DEFAULT 0, -- 0=Inactive, 1=Active, 2=ActiveAck, 3=InactiveAck, 4=Ended, 5=Disabled |
| `current_value` | `FLOAT` | NULL |
| `triggered_at` | `DATETIME2` | NULL |
| `acknowledged_at` | `DATETIME2` | NULL |
| `acknowledged_by` | `NVARCHAR(100)` | NULL |
| `ended_at` | `DATETIME2` | NULL |
| `last_updated` | `DATETIME2` | NOT NULL DEFAULT GETDATE() |

**Constraints / Keys**
- `CONSTRAINT UQ_AlarmStates_Tag UNIQUE (alarm_type, tag_id)`

### جدول: `AlarmHistory`
- **الغرض:** سجل تاريخي لكل occurrence للإنذار (Triggered/Ack/Ended) مع المدة والقيم.
| العمود | النوع | القيود/الوصف |
|---|---|---|
| `id` | `BIGINT` | IDENTITY(1,1) PRIMARY KEY |
| `alarm_type` | `NVARCHAR(20)` | NOT NULL, -- analog / discrete |
| `tag_id` | `INT` | NOT NULL |
| `tag_name` | `NVARCHAR(100)` | NOT NULL |
| `alarm_class` | `NVARCHAR(50)` | NULL |
| `alarm_number` | `INT` | NULL |
| `alarm_text` | `NVARCHAR(200)` | NOT NULL |
| `alarm_severity` | `NVARCHAR(20)` | NOT NULL, -- alarm, warning, error |
| `trigger_value` | `FLOAT` | NULL |
| `limit_value` | `FLOAT` | NULL |
| `limit_mode` | `NVARCHAR(20)` | NULL |
| `triggered_at` | `DATETIME2` | NOT NULL |
| `acknowledged_at` | `DATETIME2` | NULL |
| `acknowledged_by` | `NVARCHAR(100)` | NULL |
| `ended_at` | `DATETIME2` | NULL |
| `duration_seconds` | `INT` | NULL |
| `additional_text1` | `NVARCHAR(500)` | NULL |
| `additional_text2` | `NVARCHAR(500)` | NULL |
| `created_at` | `DATETIME2` | NOT NULL DEFAULT GETDATE() |

**Constraints / Keys**
- `-- Values`
- `-- Timestamps`
- `-- Metadata`

### جدول: `AlarmEvents`
- **الغرض:** Event stream تفصيلي (TRIGGERED/ENDED/ACK...) مرتبط بسجل AlarmHistory.
| العمود | النوع | القيود/الوصف |
|---|---|---|
| `id` | `BIGINT` | IDENTITY(1,1) PRIMARY KEY |
| `alarm_history_id` | `BIGINT` | NULL |
| `alarm_type` | `NVARCHAR(20)` | NOT NULL |
| `tag_id` | `INT` | NOT NULL |
| `tag_name` | `NVARCHAR(100)` | NOT NULL |
| `event_type` | `NVARCHAR(20)` | NOT NULL, -- TRIGGERED, ENDED, ACKNOWLEDGED, DISABLED, ENABLED |
| `event_value` | `FLOAT` | NULL |
| `event_user` | `NVARCHAR(100)` | NULL |
| `event_comment` | `NVARCHAR(500)` | NULL |
| `event_timestamp` | `DATETIME2` | NOT NULL DEFAULT GETDATE() |

**Constraints / Keys**
- `CONSTRAINT FK_AlarmEvents_History FOREIGN KEY (alarm_history_id) REFERENCES AlarmHistory(id)`

### جدول: `HistorianData`
- **الغرض:** بيانات historian time-series (tag_id + value + timestamp + quality).
| العمود | النوع | القيود/الوصف |
|---|---|---|
| `id` | `BIGINT` | IDENTITY(1,1) PRIMARY KEY |
| `tag_id` | `INT` | NOT NULL |
| `tag_name` | `NVARCHAR(100)` | NOT NULL |
| `value` | `FLOAT` | NOT NULL |
| `raw_value` | `FLOAT` | NULL |
| `quality` | `INT` | NOT NULL DEFAULT 192, -- OPC Quality: 192 = Good |
| `timestamp` | `DATETIME2` | NOT NULL |
| `created_at` | `DATETIME2` | NOT NULL DEFAULT GETDATE() |

**Constraints / Keys**
- `CONSTRAINT FK_HistorianData_Tag FOREIGN KEY (tag_id) REFERENCES HistorianTags(tag_id)`

### جدول: `SystemLogs`
- **الغرض:** تخزين لوجات النظام/الخدمات داخل DB (اختياري بجانب ملفات اللوج).
| العمود | النوع | القيود/الوصف |
|---|---|---|
| `id` | `BIGINT` | IDENTITY(1,1) PRIMARY KEY |
| `log_level` | `NVARCHAR(20)` | NOT NULL, -- DEBUG, INFO, WARN, ERROR, FATAL |
| `service_name` | `NVARCHAR(50)` | NOT NULL, -- AlarmService, HistorianService, etc. |
| `message` | `NVARCHAR(MAX)` | NOT NULL |
| `error_code` | `NVARCHAR(50)` | NULL |
| `stack_trace` | `NVARCHAR(MAX)` | NULL |
| `metadata` | `NVARCHAR(MAX)` | NULL, -- JSON |
| `timestamp` | `DATETIME2` | NOT NULL DEFAULT GETDATE() |

### جدول: `ServiceMetrics`
- **الغرض:** تخزين metrics دورية للخدمات (عدادات/قيم) داخل DB.
| العمود | النوع | القيود/الوصف |
|---|---|---|
| `id` | `BIGINT` | IDENTITY(1,1) PRIMARY KEY |
| `service_name` | `NVARCHAR(50)` | NOT NULL |
| `metric_name` | `NVARCHAR(100)` | NOT NULL |
| `metric_value` | `FLOAT` | NOT NULL |
| `metric_unit` | `NVARCHAR(20)` | NULL |
| `timestamp` | `DATETIME2` | NOT NULL DEFAULT GETDATE() |

## 6) Stored Procedures (وظائف DB)
المصدر: `database/02_stored_procedures.sql`

- `sp_GetActiveAnalogAlarmTags`: إرجاع تعريف Tags الخاصة بإنذارات Analog المفعّلة (JOIN مع PLCs/ModbusDevices).
- `sp_GetActiveDiscreteAlarmTags`: إرجاع تعريف Tags الخاصة بإنذارات Discrete المفعّلة (JOIN مع PLCs/ModbusDevices).
- `sp_GetActiveHistorianTags`: إرجاع تعريف Tags الخاصة بالـ Historian المفعّلة (reading_cycle/deadband...).
- `sp_GetActivePLCs`: إرجاع PLCs النشطة لاستخدامها في تشغيل الاتصالات.
- `sp_GetActiveModbusDevices`: إرجاع Modbus devices النشطة لاستخدامها في تشغيل الاتصالات.
- `sp_InsertAlarmEvent`: تسجيل event داخل AlarmEvents (مرن للاستخدام من الخدمات/الـ API). (Params: @alarm_history_id BIGINT = NULL, @alarm_type NVARCHAR(20), @tag_id INT, @tag_name NVARCHAR(100), @event_type NVARCHAR(20), @event_value FLOAT = NULL, @event_user NVARCHAR(100) = NULL, @event_comment NVARCHAR(500) = NULL)
- `sp_TriggerAlarm`: تسجيل Trigger لإنذار: تحديث AlarmStates + إضافة سجل AlarmHistory + event. (Params: @alarm_type NVARCHAR(20), @tag_id INT, @tag_name NVARCHAR(100), @alarm_class NVARCHAR(50) = NULL, @alarm_number INT = NULL, @alarm_text NVARCHAR(200), @alarm_severity NVARCHAR(20), @trigger_value FLOAT = NULL, @limit_value FLOAT = NULL, @limit_mode NVARCHAR(20) = NULL, @additional_text1 NVARCHAR(500) = NULL, @additional_text2 NVARCHAR(500) = NULL)
- `sp_EndAlarm`: إنهاء إنذار: تحديث AlarmStates + تحديث AlarmHistory + event. (Params: @alarm_type NVARCHAR(20), @tag_id INT, @tag_name NVARCHAR(100), @end_value FLOAT = NULL)
- `sp_AcknowledgeAlarm`: إقرار/ACK إنذار: تحديث AlarmStates + AlarmHistory + event. (Params: @alarm_type NVARCHAR(20), @tag_id INT, @acknowledged_by NVARCHAR(100), @comment NVARCHAR(500) = NULL)
- `sp_BatchInsertHistorianData`: إدخال Batch لبيانات historian باستخدام Table-Valued Parameter. (Params: @DataTable dbo.HistorianDataTableType READONLY)
- `sp_GetActiveAlarms`: إرجاع قائمة الإنذارات النشطة للاستخدام في API/WebSocket.
- `sp_GetAlarmHistory`: إرجاع AlarmHistory مع pagination + إجمالي العدد (filters اختيارية). (Params: @page INT = 1, @page_size INT = 50, @alarm_type NVARCHAR(20) = NULL, @alarm_class NVARCHAR(50) = NULL, @from_date DATETIME2 = NULL, @to_date DATETIME2 = NULL)
- `sp_GetHistorianData`: إرجاع HistorianData مع pagination ضمن فترة زمنية (tag_id اختياري). (Params: @tag_id INT = NULL, @from_date DATETIME2, @to_date DATETIME2, @page INT = 1, @page_size INT = 1000)
- `sp_InsertSystemLog`: إدخال سجل لوج داخل SystemLogs (log_level/service/message...). (Params: @log_level NVARCHAR(20), @service_name NVARCHAR(50), @message NVARCHAR(MAX), @error_code NVARCHAR(50) = NULL, @stack_trace NVARCHAR(MAX) = NULL, @metadata NVARCHAR(MAX) = NULL)

## 7) Migration: Deadband
المصدر: `database/03_migration_add_deadband.sql`

```sql
-- =====================================================
-- Migration: Add deadband_check_cycle_s column
-- Purpose: Add missing column to HistorianTags table
-- =====================================================

USE IndustrialDB;
GO

-- Add deadband_check_cycle_s column if it doesn't exist
IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_NAME = 'HistorianTags' 
    AND COLUMN_NAME = 'deadband_check_cycle_s'
)
BEGIN
    ALTER TABLE HistorianTags
    ADD deadband_check_cycle_s INT NULL DEFAULT NULL;

    PRINT 'Column deadband_check_cycle_s added successfully to HistorianTags table.';
END
ELSE
BEGIN
    PRINT 'Column deadband_check_cycle_s already exists in HistorianTags table.';
END
GO

-- Verify the column was added
SELECT 
    COLUMN_NAME, 
    DATA_TYPE, 
    IS_NULLABLE, 
    COLUMN_DEFAULT
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = 'HistorianTags' 
AND COLUMN_NAME IN ('deadband', 'deadband_check_cycle_s')
ORDER BY ORDINAL_POSITION;
GO

PRINT '==============================================';
PRINT 'Migration completed successfully!';
PRINT '==============================================';
```

## 8) مسار الداتا (Data Flow) داخل السيرفر
- `ConfigManager` يقرأ الإعدادات.
- `DatabaseManager` ينشئ Connection Pool ويحاول إعادة الاتصال تلقائيًا عند انقطاع DB.
- `PlcConnectionManager` و `ModbusConnectionManager` يقوموا بإدارة الاتصالات وعمليات القراءة thread-safe مع auto-reconnect.
- `AlarmService`:
  - يحمل Tags من DB: `sp_GetActiveAnalogAlarmTags` و `sp_GetActiveDiscreteAlarmTags`
  - يعمل scan دوري حسب `AlarmService.ScanIntervalMs`
  - يقرأ القيم من PLC/Modbus ثم يطبق equation (إن وجدت) ثم يفحص الشرط limit mode
  - يسجل Trigger/End/Ack في DB عبر SPs ويحتفظ بـ runtime state
  - يحفظ آخر الحالات في `General.StateFilePath` مثل: `data/last_alarm_states.json`
- `HistorianService`:
  - يحمل Tags من DB: `sp_GetActiveHistorianTags`
  - يسجل قراءات دورية حسب `reading_cycle_ms` + يدعم deadband (exception) لتقليل التخزين
  - يخزن في `dbo.HistorianData` باستخدام Bulk Insert
- `ApiServer` يقدم REST endpoints
- `WebSocketServer` يبث أحداث الإنذارات لحظيًا
- `RetentionService` (اختياري) يمسح بيانات قديمة حسب إعدادات retention

## 9) REST API (ملخص)
المصدر: `src/api/ApiServer.js`
أهم endpoints:
- `GET /api/health`
- `GET /api/status`
- `POST /api/auth/login` (JWT)
- Endpoints للـ alarms/historian حسب الموجود داخل الملف
- Endpoint إضافي: `GET /history` يرجّع بيانات historian بشكل مبسط للـ chart (يستدعي `sp_GetHistorianData` ويجمع كل الصفحات)

## 10) WebSocket (ملخص)
المصدر: `src/api/WebSocketServer.js`
- Path افتراضي: `/ws`
- رسائل مهمة: `PING/PONG`, `SUBSCRIBE`, `GET_ACTIVE_ALARMS`, `ACKNOWLEDGE_ALARM`
- Broadcast events: `ALARM_TRIGGERED`, `ALARM_ENDED`, `ALARM_ACKNOWLEDGED`
