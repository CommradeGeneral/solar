"""
Generate Arabic project documentation for Industrial Data Server.

This script is designed to work with *stdlib only* (no openpyxl/exceljs),
so it can run in minimal environments.

Outputs:
  docs/IndustrialDataServer_Documentation.ar.md
"""

from __future__ import annotations

import configparser
import datetime as _dt
import os
import re
import textwrap
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from xml.etree import ElementTree as ET


ROOT = Path(__file__).resolve().parent.parent
CONFIG_INI = ROOT / "config.ini"
DB_CREATE_SQL = ROOT / "database" / "01_create_database.sql"
DB_SP_SQL = ROOT / "database" / "02_stored_procedures.sql"
DB_MIGRATION_SQL = ROOT / "database" / "03_migration_add_deadband.sql"
EXCEL_FILES = [
    ROOT / "excel-data" / "Analog_Alarm.xlsx",
    ROOT / "excel-data" / "Discrete_Alarm.xlsx",
    ROOT / "excel-data" / "History.xlsx",
]
OUT_MD = ROOT / "docs" / "IndustrialDataServer_Documentation.ar.md"


def _read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


# =========================
# XLSX inspection (stdlib)
# =========================

_NS = {
    "main": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "rel": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "pkgrel": "http://schemas.openxmlformats.org/package/2006/relationships",
}


@dataclass
class XlsxSheetInfo:
    name: str
    path_in_zip: str
    headers: List[str]
    sample_rows: List[List[str]]


def _xlsx_shared_strings(z: zipfile.ZipFile) -> List[str]:
    try:
        xml = z.read("xl/sharedStrings.xml")
    except KeyError:
        return []

    root = ET.fromstring(xml)
    strings: List[str] = []
    for si in root.findall("main:si", _NS):
        # shared string can be <t> or multiple <r><t>
        t = si.find("main:t", _NS)
        if t is not None and t.text is not None:
            strings.append(t.text)
            continue
        parts = []
        for r in si.findall("main:r", _NS):
            rt = r.find("main:t", _NS)
            if rt is not None and rt.text is not None:
                parts.append(rt.text)
        strings.append("".join(parts))
    return strings


def _xlsx_sheet_map(z: zipfile.ZipFile) -> List[Tuple[str, str]]:
    """
    Returns list of (sheetName, worksheetPathInZip).
    """
    wb_xml = z.read("xl/workbook.xml")
    wb = ET.fromstring(wb_xml)

    rels_xml = z.read("xl/_rels/workbook.xml.rels")
    rels = ET.fromstring(rels_xml)
    rid_to_target: Dict[str, str] = {}
    for rel in rels.findall("pkgrel:Relationship", _NS):
        rid = rel.attrib.get("Id")
        target = rel.attrib.get("Target")
        if rid and target:
            # Targets are typically like "worksheets/sheet1.xml"
            rid_to_target[rid] = "xl/" + target.lstrip("/")

    out: List[Tuple[str, str]] = []
    sheets = wb.find("main:sheets", _NS)
    if sheets is None:
        return out

    for sh in sheets.findall("main:sheet", _NS):
        name = sh.attrib.get("name", "").strip()
        rid = sh.attrib.get(f"{{{_NS['rel']}}}id")
        target = rid_to_target.get(rid or "", "")
        if name and target:
            out.append((name, target))
    return out


def _xlsx_cell_value(
    c: ET.Element,
    shared: List[str],
) -> str:
    t = c.attrib.get("t")
    if t == "s":
        v = c.find("main:v", _NS)
        if v is None or v.text is None:
            return ""
        try:
            idx = int(v.text)
            return shared[idx] if 0 <= idx < len(shared) else ""
        except ValueError:
            return ""
    if t == "inlineStr":
        is_ = c.find("main:is", _NS)
        if is_ is None:
            return ""
        tnode = is_.find("main:t", _NS)
        return (tnode.text or "") if tnode is not None else ""

    v = c.find("main:v", _NS)
    return (v.text or "") if v is not None else ""


def _xlsx_row_values(row: ET.Element, shared: List[str]) -> List[str]:
    cells = row.findall("main:c", _NS)
    values: List[Tuple[int, str]] = []
    for c in cells:
        r = c.attrib.get("r", "")  # e.g. "C1"
        m = re.match(r"^([A-Z]+)\d+$", r)
        if not m:
            continue
        col_letters = m.group(1)
        # Convert A->1, B->2, ... AA->27
        col = 0
        for ch in col_letters:
            col = col * 26 + (ord(ch) - ord("A") + 1)
        values.append((col, _xlsx_cell_value(c, shared).strip()))
    values.sort(key=lambda x: x[0])
    # return dense list up to max col present
    if not values:
        return []
    max_col = values[-1][0]
    dense = [""] * max_col
    for col, val in values:
        dense[col - 1] = val
    return dense


def inspect_xlsx(path: Path, sample_rows: int = 3) -> Tuple[List[str], List[XlsxSheetInfo]]:
    if not path.exists():
        return [f"ملف غير موجود: {path.as_posix()}"], []

    warnings: List[str] = []
    sheets_out: List[XlsxSheetInfo] = []

    with zipfile.ZipFile(path, "r") as z:
        shared = _xlsx_shared_strings(z)
        sheet_map = _xlsx_sheet_map(z)
        if not sheet_map:
            warnings.append("لم يتم العثور على sheets داخل ملف Excel.")
            return warnings, []

        for sheet_name, sheet_path in sheet_map:
            try:
                xml = z.read(sheet_path)
            except KeyError:
                warnings.append(f"sheet مفقود داخل zip: {sheet_name} ({sheet_path})")
                continue

            root = ET.fromstring(xml)
            sheet_data = root.find("main:sheetData", _NS)
            if sheet_data is None:
                sheets_out.append(XlsxSheetInfo(sheet_name, sheet_path, [], []))
                continue

            # Find header row r="1"
            header_row = None
            for row in sheet_data.findall("main:row", _NS):
                if row.attrib.get("r") == "1":
                    header_row = row
                    break
            headers = []
            if header_row is not None:
                headers = [h for h in _xlsx_row_values(header_row, shared) if h]

            samples: List[List[str]] = []
            # Collect next N non-empty rows after row 1
            for row in sheet_data.findall("main:row", _NS):
                r = row.attrib.get("r")
                if r is None:
                    continue
                try:
                    rn = int(r)
                except ValueError:
                    continue
                if rn <= 1:
                    continue
                values = _xlsx_row_values(row, shared)
                if any(v.strip() for v in values):
                    samples.append(values)
                if len(samples) >= sample_rows:
                    break

            sheets_out.append(XlsxSheetInfo(sheet_name, sheet_path, headers, samples))

    return warnings, sheets_out


# =========================
# SQL parsing helpers
# =========================

@dataclass
class SqlTable:
    name: str
    columns: List[Tuple[str, str, str]]  # (name, type, rest)
    constraints: List[str]


def _parse_create_tables(sql_text: str) -> List[SqlTable]:
    # Capture CREATE TABLE X ( ... );
    tables: List[SqlTable] = []
    # Use non-greedy match to first ");" after CREATE TABLE.
    pattern = re.compile(
        r"CREATE\s+TABLE\s+([A-Za-z0-9_]+)\s*\((.*?)\);\s*",
        re.IGNORECASE | re.DOTALL,
    )
    for m in pattern.finditer(sql_text):
        name = m.group(1)
        body = m.group(2)
        lines = [ln.rstrip() for ln in body.splitlines() if ln.strip()]

        columns: List[Tuple[str, str, str]] = []
        constraints: List[str] = []
        for ln in lines:
            # remove trailing comma
            l = ln.strip().rstrip(",")
            if not l:
                continue
            if l.upper().startswith("CONSTRAINT "):
                constraints.append(l)
                continue
            # Column definition often: colName TYPE [NULL|NOT NULL] [DEFAULT ...] ...
            cm = re.match(r"^([A-Za-z0-9_]+)\s+([A-Za-z0-9_]+(?:\([^\)]*\))?)\s*(.*)$", l)
            if not cm:
                # Maybe a table-level clause; keep as constraint-ish.
                constraints.append(l)
                continue
            col_name, col_type, rest = cm.group(1), cm.group(2), cm.group(3).strip()
            columns.append((col_name, col_type, rest))

        tables.append(SqlTable(name=name, columns=columns, constraints=constraints))
    return tables


@dataclass
class SqlProcedure:
    name: str
    params: List[str]


def _parse_procedures(sql_text: str) -> List[SqlProcedure]:
    procs: List[SqlProcedure] = []
    # Find "CREATE OR ALTER PROCEDURE procName" blocks
    head_re = re.compile(
        r"CREATE\s+OR\s+ALTER\s+PROCEDURE\s+([A-Za-z0-9_]+)\s*(.*?)\bAS\b",
        re.IGNORECASE | re.DOTALL,
    )
    for m in head_re.finditer(sql_text):
        name = m.group(1)
        param_blob = m.group(2) or ""
        # params are lines starting with @
        params = []
        for ln in param_blob.splitlines():
            ln = ln.strip().rstrip(",")
            if ln.startswith("@"):
                params.append(ln)
        procs.append(SqlProcedure(name=name, params=params))
    return procs


def _ini_to_md(path: Path) -> str:
    if not path.exists():
        return "ملف `config.ini` غير موجود."
    cfg = configparser.ConfigParser(interpolation=None)
    # Preserve key casing to match config.ini as-written
    cfg.optionxform = str  # type: ignore[attr-defined]
    cfg.read(path, encoding="utf-8")

    lines: List[str] = []
    for section in cfg.sections():
        lines.append(f"### [{section}]")
        for key, value in cfg.items(section):
            lines.append(f"- `{key}` = `{value}`")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def _md_escape(s: str) -> str:
    return s.replace("|", "\\|")


def main() -> None:
    now = _dt.datetime.now().astimezone()

    config_md = _ini_to_md(CONFIG_INI)

    create_sql = _read_text(DB_CREATE_SQL) if DB_CREATE_SQL.exists() else ""
    tables = _parse_create_tables(create_sql)

    sp_sql = _read_text(DB_SP_SQL) if DB_SP_SQL.exists() else ""
    procs = _parse_procedures(sp_sql)

    migration_sql = _read_text(DB_MIGRATION_SQL) if DB_MIGRATION_SQL.exists() else ""

    excel_sections: List[str] = []
    for xf in EXCEL_FILES:
        warnings, sheets = inspect_xlsx(xf)
        excel_sections.append(f"### ملف: `{xf.relative_to(ROOT).as_posix()}`")
        if warnings:
            excel_sections.append("- تحذيرات:")
            for w in warnings:
                excel_sections.append(f"  - {w}")
        for sh in sheets:
            excel_sections.append(f"- Sheet: **{_md_escape(sh.name)}**")
            if sh.headers:
                excel_sections.append(f"  - الأعمدة (Header row): {', '.join(f'`{_md_escape(h)}`' for h in sh.headers)}")
            else:
                excel_sections.append("  - الأعمدة: (غير موجودة / صف 1 فارغ)")
            if sh.sample_rows:
                excel_sections.append("  - أمثلة (أول 3 صفوف بيانات):")
                for i, row in enumerate(sh.sample_rows, 1):
                    excel_sections.append("    - " + " | ".join(f"`{_md_escape(v)}`" for v in row if v != ""))
            else:
                excel_sections.append("  - أمثلة: (لا توجد بيانات واضحة)")
        excel_sections.append("")

    tables_md_lines: List[str] = []
    table_purposes: Dict[str, str] = {
        "PLCs": "تعريف أجهزة Siemens S7 (عنوان IP + rack/slot) التي يتم الاتصال بها.",
        "ModbusDevices": "تعريف أجهزة Modbus (TCP/RTU) وباراميترات الاتصال (IP/Port أو Serial).",
        "AnalogAlarmTags": "تعريف Tags الخاصة بإنذارات Analog (Limit + Mode + مصدر القراءة PLC/Modbus).",
        "DiscreteAlarmTags": "تعريف Tags الخاصة بإنذارات Discrete (HIGH/LOW) + مصدر القراءة PLC/Modbus.",
        "HistorianTags": "تعريف Tags الخاصة بالـ Historian (الدورية + deadband) + مصدر القراءة PLC/Modbus.",
        "AlarmStates": "الحالة الحالية/الـ runtime state لكل إنذار (active/ack/ended...) للاستخدام في API/WebSocket.",
        "AlarmHistory": "سجل تاريخي لكل occurrence للإنذار (Triggered/Ack/Ended) مع المدة والقيم.",
        "AlarmEvents": "Event stream تفصيلي (TRIGGERED/ENDED/ACK...) مرتبط بسجل AlarmHistory.",
        "HistorianData": "بيانات historian time-series (tag_id + value + timestamp + quality).",
        "SystemLogs": "تخزين لوجات النظام/الخدمات داخل DB (اختياري بجانب ملفات اللوج).",
        "ServiceMetrics": "تخزين metrics دورية للخدمات (عدادات/قيم) داخل DB.",
    }

    for t in tables:
        tables_md_lines.append(f"### جدول: `{t.name}`")
        purpose = table_purposes.get(t.name)
        if purpose:
            tables_md_lines.append(f"- **الغرض:** {purpose}")
        if t.columns:
            tables_md_lines.append("| العمود | النوع | القيود/الوصف |")
            tables_md_lines.append("|---|---|---|")
            for col_name, col_type, rest in t.columns:
                tables_md_lines.append(
                    f"| `{_md_escape(col_name)}` | `{_md_escape(col_type)}` | {_md_escape(rest) if rest else ''} |"
                )
        else:
            tables_md_lines.append("- (تعذر استخراج الأعمدة تلقائيًا من SQL)")
        if t.constraints:
            tables_md_lines.append("")
            tables_md_lines.append("**Constraints / Keys**")
            for c in t.constraints:
                tables_md_lines.append(f"- `{_md_escape(c)}`")
        tables_md_lines.append("")

    procs_md_lines: List[str] = []
    proc_purposes: Dict[str, str] = {
        "sp_GetActiveAnalogAlarmTags": "إرجاع تعريف Tags الخاصة بإنذارات Analog المفعّلة (JOIN مع IEC104Devices/ModbusDevices).",
        "sp_GetActiveDiscreteAlarmTags": "إرجاع تعريف Tags الخاصة بإنذارات Discrete المفعّلة (JOIN مع IEC104Devices/ModbusDevices).",
        "sp_GetActiveHistorianTags": "إرجاع تعريف Tags الخاصة بالـ Historian المفعّلة (reading_cycle/deadband...).",
        "sp_GetActiveIEC104Devices": "إرجاع أجهزة IEC104 النشطة لاستخدامها في تشغيل الاتصالات.",
        "sp_GetActiveModbusDevices": "إرجاع Modbus devices النشطة لاستخدامها في تشغيل الاتصالات.",
        "sp_InsertAlarmEvent": "تسجيل event داخل AlarmEvents (مرن للاستخدام من الخدمات/الـ API).",
        "sp_TriggerAlarm": "تسجيل Trigger لإنذار: تحديث AlarmStates + إضافة سجل AlarmHistory + event.",
        "sp_EndAlarm": "إنهاء إنذار: تحديث AlarmStates + تحديث AlarmHistory + event.",
        "sp_AcknowledgeAlarm": "إقرار/ACK إنذار: تحديث AlarmStates + AlarmHistory + event.",
        "sp_BatchInsertHistorianData": "إدخال Batch لبيانات historian باستخدام Table-Valued Parameter.",
        "sp_GetActiveAlarms": "إرجاع قائمة الإنذارات النشطة للاستخدام في API/WebSocket.",
        "sp_GetAlarmHistory": "إرجاع AlarmHistory مع pagination + إجمالي العدد (filters اختيارية).",
        "sp_GetHistorianData": "إرجاع HistorianData مع pagination ضمن فترة زمنية (tag_id اختياري).",
        "sp_InsertSystemLog": "إدخال سجل لوج داخل SystemLogs (log_level/service/message...).",
    }
    for p in procs:
        desc = proc_purposes.get(p.name)
        if p.params:
            procs_md_lines.append(f"- `{p.name}`: {desc or ''} (Params: {', '.join(p.params)})")
        else:
            procs_md_lines.append(f"- `{p.name}`: {desc or ''}".rstrip())

    excel_columns_explained = """\
## 4.1) شرح أعمدة Excel (المتوقع استخدامها)
### Sheets: IEC104 / IEC104Devices
- `device_id`: معرف فريد للجهاز (PK في `IEC104Devices`).
- `device_name`: اسم وصفي للجهاز (RTU / Logger).
- `ip_address`: عنوان IP للجهاز.
- `port`: بورت IEC104 (افتراضي 2404).
- `t1`, `t2`, `t3`: مؤقتات الـ APCI (ثوانٍ).
- `k`, `w`: نوافذ تأكيد إطارات I.
- `gi_interval`: فترة الـ General Interrogation (ثوانٍ).
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
**حقول تعريف مصدر القراءة (IEC104):**
- `protocol_type`: `iec104` أو `modbus` أو `internal` (للتاجات المحسوبة).
- `iec104_device_id`: يربط بالجهاز في `IEC104Devices`.
- `iec104_asdu_address`: عنوان ASDU (Common Address).
- `iec104_ioa`: عنوان كائن المعلومة (IOA).
- `iec104_type_id`: نوع الرسالة (رقم مثل 13 أو mnemonic مثل `M_ME_NC_1`).

**حقول تعريف مصدر القراءة (Modbus):**
- `modbus_device_id`: يربط بالجهاز في `ModbusDevices`.
- `register_type`: نوع الريجستر (مثل `1x/3x/4x` أو `1x,2x,3x,4x` حسب الملف).
- `modbus_address`: عنوان الريجستر (يدعم `register.bit` مثل `281.12` = العنوان 281 البت 12).
- `bit_offset` / `bit`: رقم البِت داخل الريجستر (بديل عن صيغة `register.bit`).
- `register_count`: عدد الريجسترات (مثلاً 2 للـ float).
- `word_order`: ترتيب الكلمات للقيم متعددة الريجسترات (`ABCD`/`CDAB`/`BADC`/`DCBA`).

**تحويل البيانات والمعادلات:**
- `data_type`: نوع البيانات (مثل `Bool`, `int`, `uint`, `dint`, `real`...).
- `equation`: معادلة mathjs تستخدم `x` (مثال: `(x/27648)`).
- `calc`: معادلة للتاج المحسوب (internal) تشير لتاجات أخرى بالاسم (مثال: `INV003_Run * INV003_PowerFactor`).

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
"""

    out = f"""\
# توثيق مشروع: Industrial Data Server

تاريخ التوليد: {now.strftime('%Y-%m-%d %H:%M %Z')}

## 1) نظرة عامة
مشروع Node.js يعمل كسيرفر **Alarms + Historian** للبيانات الصناعية مع دعم:
- IEC 60870-5-104 (client) عبر مكتبة `net` المدمجة
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

{config_md}

## 4) ملفات Excel المستخدمة (مصادر Tags/Devices)
يوجد فولدر `excel-data/` وفيه 3 ملفات رئيسية. **الأعمدة بالأسفل مأخوذة من Row 1 داخل كل Sheet**:

{("\n".join(excel_sections)).rstrip()}

### ملاحظة مهمة عن Excel
- الاستيراد الفعلي للـ Tags/Devices من Excel يتم عبر `tools/import-excel.js` ويعتمد على أسماء Sheets معيّنة (مثل: `Tags`, `PLCs`, `ModbusDevices`).
- في التشغيل العادي، السيرفر يقرأ الـ Tags من قاعدة البيانات عبر Stored Procedures، وميزة `ExcelDevices.Enabled=true` تُستخدم فقط لتحميل **تعريف الأجهزة (PLCs/Modbus)** من Excel ومتابعة التغييرات (Watcher).

{excel_columns_explained.strip()}

## 5) قاعدة البيانات (SQL Server) - الجداول والأعمدة
المصدر: `database/01_create_database.sql`

{("\n".join(tables_md_lines)).rstrip()}

## 6) Stored Procedures (وظائف DB)
المصدر: `database/02_stored_procedures.sql`

{("\n".join(procs_md_lines)).rstrip()}

## 7) Migration: Deadband
المصدر: `database/03_migration_add_deadband.sql`

```sql
{migration_sql.strip()}
```

## 8) مسار الداتا (Data Flow) داخل السيرفر
- `ConfigManager` يقرأ الإعدادات.
- `DatabaseManager` ينشئ Connection Pool ويحاول إعادة الاتصال تلقائيًا عند انقطاع DB.
- `Iec104ConnectionManager` و `ModbusConnectionManager` يقوموا بإدارة الاتصالات وعمليات القراءة مع auto-reconnect.
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
"""

    OUT_MD.parent.mkdir(parents=True, exist_ok=True)
    # Write with BOM to avoid mojibake in some Windows tooling (PowerShell/Notepad).
    OUT_MD.write_text(textwrap.dedent(out).strip() + "\n", encoding="utf-8-sig")
    print(f"Wrote: {OUT_MD}")


if __name__ == "__main__":
    main()
