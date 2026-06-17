-- =====================================================
-- Industrial Data Server - Database Setup
-- SQL Server Edition
-- =====================================================

-- إنشاء قاعدة البيانات
IF NOT EXISTS (SELECT name FROM sys.databases WHERE name = 'IndustrialDB')
BEGIN
    CREATE DATABASE IndustrialDB;
END
GO

USE IndustrialDB;
GO

-- =====================================================
-- 1. IEC104Devices Table - أجهزة IEC 60870-5-104 (RTU / Logger)
-- =====================================================
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'IEC104Devices')
BEGIN
    CREATE TABLE IEC104Devices (
        device_id       NVARCHAR(50)    PRIMARY KEY,
        device_name     NVARCHAR(100)   NOT NULL,
        ip_address      NVARCHAR(50)    NOT NULL,
        port            INT             NOT NULL DEFAULT 2404,
        -- IEC104 APCI timers / window parameters
        t1              INT             NULL DEFAULT 15,   -- ack timeout for sent APDUs (s)
        t2              INT             NULL DEFAULT 10,   -- ack timeout for received I-frames (s)
        t3              INT             NULL DEFAULT 20,   -- idle timeout before TESTFR (s)
        k               INT             NULL DEFAULT 12,   -- max unacknowledged sent I-frames
        w               INT             NULL DEFAULT 8,    -- ack after receiving w I-frames
        gi_interval     INT             NULL DEFAULT 60,   -- general interrogation period (s)
        description     NVARCHAR(500)   NULL,
        is_active       BIT             NOT NULL DEFAULT 1,
        created_at      DATETIME2       NOT NULL DEFAULT GETDATE(),
        updated_at      DATETIME2       NOT NULL DEFAULT GETDATE()
    );

    CREATE INDEX IX_IEC104Devices_Active ON IEC104Devices(is_active);
END
GO

-- =====================================================
-- 2. ModbusDevices Table - أجهزة Modbus TCP/RTU
-- =====================================================
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'ModbusDevices')
BEGIN
    CREATE TABLE ModbusDevices (
        device_id           NVARCHAR(50)    PRIMARY KEY,
        device_name         NVARCHAR(100)   NOT NULL,
        ip_address          NVARCHAR(50)    NULL,
        port                INT             NULL DEFAULT 502,
        unit_id             INT             NOT NULL DEFAULT 1,
        connection_type     NVARCHAR(10)    NOT NULL DEFAULT 'tcp', -- tcp / rtu
        serial_port         NVARCHAR(20)    NULL,  -- COM1, /dev/ttyUSB0
        baud_rate           INT             NULL DEFAULT 9600,
        parity              NVARCHAR(10)    NULL DEFAULT 'none',
        stop_bits           INT             NULL DEFAULT 1,
        data_bits           INT             NULL DEFAULT 8,
        description         NVARCHAR(500)   NULL,
        is_active           BIT             NOT NULL DEFAULT 1,
        created_at          DATETIME2       NOT NULL DEFAULT GETDATE(),
        updated_at          DATETIME2       NOT NULL DEFAULT GETDATE()
    );
    
    CREATE INDEX IX_ModbusDevices_Active ON ModbusDevices(is_active);
END
GO

-- =====================================================
-- 3. AnalogAlarmTags Table - إنذارات تناظرية
-- =====================================================
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'AnalogAlarmTags')
BEGIN
    CREATE TABLE AnalogAlarmTags (
        id                  INT             PRIMARY KEY,
        tag_name            NVARCHAR(100)   NOT NULL,
        protocol_type       NVARCHAR(20)    NOT NULL, -- iec104 / modbus / internal
        -- IEC 60870-5-104 Fields
        iec104_device_id    NVARCHAR(50)    NULL,
        iec104_asdu_address INT             NULL,  -- common ASDU address
        iec104_ioa          INT             NULL,  -- information object address
        iec104_type_id      INT             NULL,  -- 1,3,9,11,13,15,21
        -- Modbus Fields
        modbus_device_id    NVARCHAR(50)    NULL,
        register_type       NVARCHAR(10)    NULL, -- 1x, 2x, 3x, 4x
        modbus_address      INT             NULL,
        bit_offset          INT             NULL, -- modbus register.bit (e.g. 281.12 -> bit 12)
        register_count      INT             NULL DEFAULT 1,
        word_order          NVARCHAR(10)    NULL, -- ABCD (default) / CDAB / BADC / DCBA
        -- Data Processing
        data_type           NVARCHAR(20)    NOT NULL, -- int, uint, dint, udint, real, bool
        equation            NVARCHAR(200)   NULL, -- e.g. (x/27648)
        calc                NVARCHAR(500)   NULL, -- internal/calc tag formula (tagA * tagB)
        -- Alarm Configuration
        limit_value         FLOAT           NOT NULL,
        limit_mode          NVARCHAR(20)    NOT NULL, -- Equal, Greater, Smaller, GreaterOrEqual, SmallerOrEqual
        limit_is_editable   BIT             NOT NULL DEFAULT 1,
        -- Alarm Metadata
        alarm_class         NVARCHAR(50)    NULL,
        alarm_number        INT             NULL,
        alarm_type          NVARCHAR(20)    NOT NULL DEFAULT 'alarm', -- alarm, warning, error
        alarm_text          NVARCHAR(200)   NOT NULL,
        alarm_tooltip       NVARCHAR(500)   NULL,
        additional_text1    NVARCHAR(500)   NULL,
        additional_text2    NVARCHAR(500)   NULL,
        -- Anti-Chatter Settings
        consecutive_true_count  INT         NOT NULL DEFAULT 3,
        consecutive_false_count INT         NOT NULL DEFAULT 3,
        chatter_filter_ms       INT         NOT NULL DEFAULT 1000,
        -- Status
        is_enabled          BIT             NOT NULL DEFAULT 1,
        created_at          DATETIME2       NOT NULL DEFAULT GETDATE(),
        updated_at          DATETIME2       NOT NULL DEFAULT GETDATE(),
        
        -- Foreign Keys
        CONSTRAINT FK_AnalogAlarm_IEC104 FOREIGN KEY (iec104_device_id) REFERENCES IEC104Devices(device_id),
        CONSTRAINT FK_AnalogAlarm_Modbus FOREIGN KEY (modbus_device_id) REFERENCES ModbusDevices(device_id)
    );

    CREATE INDEX IX_AnalogAlarmTags_Enabled ON AnalogAlarmTags(is_enabled);
    CREATE INDEX IX_AnalogAlarmTags_Protocol ON AnalogAlarmTags(protocol_type);
    CREATE INDEX IX_AnalogAlarmTags_IEC104 ON AnalogAlarmTags(iec104_device_id) WHERE iec104_device_id IS NOT NULL;
    CREATE INDEX IX_AnalogAlarmTags_Modbus ON AnalogAlarmTags(modbus_device_id) WHERE modbus_device_id IS NOT NULL;
END
GO

-- =====================================================
-- 4. DiscreteAlarmTags Table - إنذارات رقمية
-- =====================================================
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'DiscreteAlarmTags')
BEGIN
    CREATE TABLE DiscreteAlarmTags (
        id                  INT             PRIMARY KEY,
        tag_name            NVARCHAR(100)   NOT NULL,
        protocol_type       NVARCHAR(20)    NOT NULL, -- iec104 / modbus / internal
        -- IEC 60870-5-104 Fields
        iec104_device_id    NVARCHAR(50)    NULL,
        iec104_asdu_address INT             NULL,
        iec104_ioa          INT             NULL,
        iec104_type_id      INT             NULL,
        -- Modbus Fields
        modbus_device_id    NVARCHAR(50)    NULL,
        register_type       NVARCHAR(10)    NULL,
        modbus_address      INT             NULL,
        bit_offset          INT             NULL, -- modbus register.bit
        register_count      INT             NULL DEFAULT 1,
        word_order          NVARCHAR(10)    NULL, -- ABCD (default) / CDAB / BADC / DCBA
        -- Data Processing
        data_type           NVARCHAR(20)    NOT NULL DEFAULT 'Bool',
        equation            NVARCHAR(200)   NULL,
        calc                NVARCHAR(500)   NULL, -- internal/calc tag formula
        -- Alarm Configuration
        limit_mode          NVARCHAR(10)    NOT NULL DEFAULT 'High', -- High / Low
        -- Alarm Metadata
        alarm_class         NVARCHAR(50)    NULL,
        alarm_number        INT             NULL,
        alarm_type          NVARCHAR(20)    NOT NULL DEFAULT 'alarm',
        alarm_text          NVARCHAR(200)   NOT NULL,
        alarm_tooltip       NVARCHAR(500)   NULL,
        -- Anti-Chatter Settings
        consecutive_true_count  INT         NOT NULL DEFAULT 3,
        consecutive_false_count INT         NOT NULL DEFAULT 3,
        chatter_filter_ms       INT         NOT NULL DEFAULT 1000,
        -- Status
        is_enabled          BIT             NOT NULL DEFAULT 1,
        created_at          DATETIME2       NOT NULL DEFAULT GETDATE(),
        updated_at          DATETIME2       NOT NULL DEFAULT GETDATE(),
        
        CONSTRAINT FK_DiscreteAlarm_IEC104 FOREIGN KEY (iec104_device_id) REFERENCES IEC104Devices(device_id),
        CONSTRAINT FK_DiscreteAlarm_Modbus FOREIGN KEY (modbus_device_id) REFERENCES ModbusDevices(device_id)
    );

    CREATE INDEX IX_DiscreteAlarmTags_Enabled ON DiscreteAlarmTags(is_enabled);
    CREATE INDEX IX_DiscreteAlarmTags_Protocol ON DiscreteAlarmTags(protocol_type);
END
GO

-- =====================================================
-- 5. HistorianTags Table - تاغات التسجيل
-- =====================================================
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'HistorianTags')
BEGIN
    CREATE TABLE HistorianTags (
        tag_id              INT             PRIMARY KEY,
        tag_name            NVARCHAR(100)   NOT NULL,
        protocol_type       NVARCHAR(20)    NOT NULL, -- iec104 / modbus / internal
        -- IEC 60870-5-104 Fields
        iec104_device_id    NVARCHAR(50)    NULL,
        iec104_asdu_address INT             NULL,
        iec104_ioa          INT             NULL,
        iec104_type_id      INT             NULL,
        -- Modbus Fields
        modbus_device_id    NVARCHAR(50)    NULL,
        register_type       NVARCHAR(10)    NULL,
        modbus_address      INT             NULL,
        bit_offset          INT             NULL, -- modbus register.bit
        register_count      INT             NULL DEFAULT 1,
        word_order          NVARCHAR(10)    NULL, -- ABCD (default) / CDAB / BADC / DCBA
        -- Data Processing
        data_type           NVARCHAR(20)    NOT NULL,
        equation            NVARCHAR(200)   NULL,
        calc                NVARCHAR(500)   NULL, -- internal/calc tag formula
        -- Historian Settings
        description         NVARCHAR(500)   NULL,
        reading_cycle       NVARCHAR(20)    NOT NULL DEFAULT '1 min', -- 1 sec, 5 sec, 1 min, 5 min, etc.
        reading_cycle_ms    INT             NOT NULL DEFAULT 60000,
        -- Deadband Settings (0 or NULL = disabled, value = ± threshold on processedValue)
        deadband            FLOAT           NULL DEFAULT 0,
        deadband_check_cycle_s INT          NULL DEFAULT NULL, -- fast check interval in whole seconds (NULL = disabled)
        -- Status
        is_enabled          BIT             NOT NULL DEFAULT 1,
        created_at          DATETIME2       NOT NULL DEFAULT GETDATE(),
        updated_at          DATETIME2       NOT NULL DEFAULT GETDATE(),
        
        CONSTRAINT FK_Historian_IEC104 FOREIGN KEY (iec104_device_id) REFERENCES IEC104Devices(device_id),
        CONSTRAINT FK_Historian_Modbus FOREIGN KEY (modbus_device_id) REFERENCES ModbusDevices(device_id)
    );
    
    CREATE INDEX IX_HistorianTags_Enabled ON HistorianTags(is_enabled);
    CREATE INDEX IX_HistorianTags_Cycle ON HistorianTags(reading_cycle_ms);
END
GO

-- =====================================================
-- 6. AlarmStates Table - حالات الإنذارات الحالية
-- =====================================================
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'AlarmStates')
BEGIN
    CREATE TABLE AlarmStates (
        id                  INT IDENTITY(1,1) PRIMARY KEY,
        alarm_type          NVARCHAR(20)    NOT NULL, -- analog / discrete
        tag_id              INT             NOT NULL,
        state_code          INT             NOT NULL DEFAULT 0, -- 0=Inactive, 1=Active, 2=ActiveAck, 3=InactiveAck, 4=Ended, 5=Disabled
        current_value       FLOAT           NULL,
        triggered_at        DATETIME2       NULL,
        acknowledged_at     DATETIME2       NULL,
        acknowledged_by     NVARCHAR(100)   NULL,
        ended_at            DATETIME2       NULL,
        last_updated        DATETIME2       NOT NULL DEFAULT GETDATE(),
        
        CONSTRAINT UQ_AlarmStates_Tag UNIQUE (alarm_type, tag_id)
    );
    
    CREATE INDEX IX_AlarmStates_State ON AlarmStates(state_code);
    CREATE INDEX IX_AlarmStates_Type ON AlarmStates(alarm_type);
END
GO

-- =====================================================
-- 7. AlarmHistory Table - سجل الإنذارات
-- =====================================================
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'AlarmHistory')
BEGIN
    CREATE TABLE AlarmHistory (
        id                  BIGINT IDENTITY(1,1) PRIMARY KEY,
        alarm_type          NVARCHAR(20)    NOT NULL, -- analog / discrete
        tag_id              INT             NOT NULL,
        tag_name            NVARCHAR(100)   NOT NULL,
        alarm_class         NVARCHAR(50)    NULL,
        alarm_number        INT             NULL,
        alarm_text          NVARCHAR(200)   NOT NULL,
        alarm_severity      NVARCHAR(20)    NOT NULL, -- alarm, warning, error
        -- Values
        trigger_value       FLOAT           NULL,
        limit_value         FLOAT           NULL,
        limit_mode          NVARCHAR(20)    NULL,
        -- Timestamps
        triggered_at        DATETIME2       NOT NULL,
        acknowledged_at     DATETIME2       NULL,
        acknowledged_by     NVARCHAR(100)   NULL,
        ended_at            DATETIME2       NULL,
        duration_seconds    INT             NULL,
        -- Metadata
        additional_text1    NVARCHAR(500)   NULL,
        additional_text2    NVARCHAR(500)   NULL,
        created_at          DATETIME2       NOT NULL DEFAULT GETDATE()
    );
    
    CREATE INDEX IX_AlarmHistory_TriggeredAt ON AlarmHistory(triggered_at DESC);
    CREATE INDEX IX_AlarmHistory_TagId ON AlarmHistory(tag_id, alarm_type);
    CREATE INDEX IX_AlarmHistory_Severity ON AlarmHistory(alarm_severity);
    CREATE INDEX IX_AlarmHistory_Class ON AlarmHistory(alarm_class) WHERE alarm_class IS NOT NULL;
    
    -- Partition hint: Consider partitioning by triggered_at for large datasets
END
GO

-- =====================================================
-- 8. AlarmEvents Table - أحداث الإنذارات
-- =====================================================
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'AlarmEvents')
BEGIN
    CREATE TABLE AlarmEvents (
        id                  BIGINT IDENTITY(1,1) PRIMARY KEY,
        alarm_history_id    BIGINT          NULL,
        alarm_type          NVARCHAR(20)    NOT NULL,
        tag_id              INT             NOT NULL,
        tag_name            NVARCHAR(100)   NOT NULL,
        event_type          NVARCHAR(20)    NOT NULL, -- TRIGGERED, ENDED, ACKNOWLEDGED, DISABLED, ENABLED
        event_value         FLOAT           NULL,
        event_user          NVARCHAR(100)   NULL,
        event_comment       NVARCHAR(500)   NULL,
        event_timestamp     DATETIME2       NOT NULL DEFAULT GETDATE(),
        
        CONSTRAINT FK_AlarmEvents_History FOREIGN KEY (alarm_history_id) REFERENCES AlarmHistory(id)
    );
    
    CREATE INDEX IX_AlarmEvents_Timestamp ON AlarmEvents(event_timestamp DESC);
    CREATE INDEX IX_AlarmEvents_Type ON AlarmEvents(event_type);
    CREATE INDEX IX_AlarmEvents_HistoryId ON AlarmEvents(alarm_history_id) WHERE alarm_history_id IS NOT NULL;
END
GO

-- =====================================================
-- 9. HistorianData Table - القيم المسجلة
-- =====================================================
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'HistorianData')
BEGIN
    CREATE TABLE HistorianData (
        id                  BIGINT IDENTITY(1,1) PRIMARY KEY,
        tag_id              INT             NOT NULL,
        tag_name            NVARCHAR(100)   NOT NULL,
        value               FLOAT           NULL,  -- NULL + quality=0 (Bad) marks "device disconnected"
        raw_value           FLOAT           NULL,
        quality             INT             NOT NULL DEFAULT 192, -- OPC Quality: 192 = Good, 0 = Bad
        timestamp           DATETIME2       NOT NULL,
        created_at          DATETIME2       NOT NULL DEFAULT GETDATE(),
        
        CONSTRAINT FK_HistorianData_Tag FOREIGN KEY (tag_id) REFERENCES HistorianTags(tag_id)
    );
    
    CREATE INDEX IX_HistorianData_Timestamp ON HistorianData(timestamp DESC);
    CREATE INDEX IX_HistorianData_TagId ON HistorianData(tag_id, timestamp DESC);
    
    -- Partition hint: Strongly consider partitioning by timestamp for historian data
END
GO

-- =====================================================
-- 10. SystemLogs Table - سجل النظام
-- =====================================================
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'SystemLogs')
BEGIN
    CREATE TABLE SystemLogs (
        id                  BIGINT IDENTITY(1,1) PRIMARY KEY,
        log_level           NVARCHAR(20)    NOT NULL, -- DEBUG, INFO, WARN, ERROR, FATAL
        service_name        NVARCHAR(50)    NOT NULL, -- AlarmService, HistorianService, etc.
        message             NVARCHAR(MAX)   NOT NULL,
        error_code          NVARCHAR(50)    NULL,
        stack_trace         NVARCHAR(MAX)   NULL,
        metadata            NVARCHAR(MAX)   NULL, -- JSON
        timestamp           DATETIME2       NOT NULL DEFAULT GETDATE()
    );
    
    CREATE INDEX IX_SystemLogs_Timestamp ON SystemLogs(timestamp DESC);
    CREATE INDEX IX_SystemLogs_Level ON SystemLogs(log_level);
    CREATE INDEX IX_SystemLogs_Service ON SystemLogs(service_name);
END
GO

PRINT '✅ All tables created successfully!';
GO
