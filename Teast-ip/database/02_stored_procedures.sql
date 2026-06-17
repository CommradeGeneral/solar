-- =====================================================
-- Industrial Data Server - Stored Procedures
-- =====================================================

USE IndustrialDB;
GO

-- =====================================================
-- SP: Get Active Analog Alarm Tags
-- =====================================================
CREATE OR ALTER PROCEDURE sp_GetActiveAnalogAlarmTags
AS
BEGIN
    SET NOCOUNT ON;
    
    SELECT 
        a.id,
        a.tag_name,
        a.protocol_type,
        a.iec104_device_id,
        i.ip_address AS iec104_ip,
        i.port AS iec104_port,
        a.iec104_asdu_address,
        a.iec104_ioa,
        a.iec104_type_id,
        a.modbus_device_id,
        m.ip_address AS modbus_ip,
        m.port AS modbus_port,
        m.unit_id AS modbus_unit_id,
        m.connection_type AS modbus_connection_type,
        a.register_type,
        a.modbus_address,
        a.bit_offset,
        a.register_count,
        a.word_order,
        a.data_type,
        a.equation,
        a.calc,
        a.limit_value,
        a.limit_mode,
        a.alarm_class,
        a.alarm_number,
        a.alarm_type,
        a.alarm_text,
        a.alarm_tooltip,
        a.additional_text1,
        a.additional_text2,
        a.consecutive_true_count,
        a.consecutive_false_count,
        a.chatter_filter_ms
    FROM AnalogAlarmTags a
    LEFT JOIN IEC104Devices i ON a.iec104_device_id = i.device_id AND i.is_active = 1
    LEFT JOIN ModbusDevices m ON a.modbus_device_id = m.device_id AND m.is_active = 1
    WHERE a.is_enabled = 1
    ORDER BY a.id;
END
GO

-- =====================================================
-- SP: Get Active Discrete Alarm Tags
-- =====================================================
CREATE OR ALTER PROCEDURE sp_GetActiveDiscreteAlarmTags
AS
BEGIN
    SET NOCOUNT ON;
    
    SELECT 
        d.id,
        d.tag_name,
        d.protocol_type,
        d.iec104_device_id,
        i.ip_address AS iec104_ip,
        i.port AS iec104_port,
        d.iec104_asdu_address,
        d.iec104_ioa,
        d.iec104_type_id,
        d.modbus_device_id,
        m.ip_address AS modbus_ip,
        m.port AS modbus_port,
        m.unit_id AS modbus_unit_id,
        m.connection_type AS modbus_connection_type,
        d.register_type,
        d.modbus_address,
        d.bit_offset,
        d.register_count,
        d.word_order,
        d.data_type,
        d.equation,
        d.calc,
        d.limit_mode,
        d.alarm_class,
        d.alarm_number,
        d.alarm_type,
        d.alarm_text,
        d.alarm_tooltip,
        d.consecutive_true_count,
        d.consecutive_false_count,
        d.chatter_filter_ms
    FROM DiscreteAlarmTags d
    LEFT JOIN IEC104Devices i ON d.iec104_device_id = i.device_id AND i.is_active = 1
    LEFT JOIN ModbusDevices m ON d.modbus_device_id = m.device_id AND m.is_active = 1
    WHERE d.is_enabled = 1
    ORDER BY d.id;
END
GO

-- =====================================================
-- SP: Get Active Historian Tags
-- =====================================================
CREATE OR ALTER PROCEDURE sp_GetActiveHistorianTags
AS
BEGIN
    SET NOCOUNT ON;
    
    SELECT 
        h.tag_id,
        h.tag_name,
        h.protocol_type,
        h.iec104_device_id,
        i.ip_address AS iec104_ip,
        i.port AS iec104_port,
        h.iec104_asdu_address,
        h.iec104_ioa,
        h.iec104_type_id,
        h.modbus_device_id,
        m.ip_address AS modbus_ip,
        m.port AS modbus_port,
        m.unit_id AS modbus_unit_id,
        m.connection_type AS modbus_connection_type,
        h.register_type,
        h.modbus_address,
        h.bit_offset,
        h.register_count,
        h.word_order,
        h.data_type,
        h.equation,
        h.calc,
        h.description,
        h.reading_cycle,
        h.reading_cycle_ms,
        h.deadband,
        h.deadband_check_cycle_s
    FROM HistorianTags h
    LEFT JOIN IEC104Devices i ON h.iec104_device_id = i.device_id AND i.is_active = 1
    LEFT JOIN ModbusDevices m ON h.modbus_device_id = m.device_id AND m.is_active = 1
    WHERE h.is_enabled = 1
    ORDER BY h.tag_id;
END
GO

-- =====================================================
-- SP: Get Active IEC104 Devices
-- =====================================================
CREATE OR ALTER PROCEDURE sp_GetActiveIEC104Devices
AS
BEGIN
    SET NOCOUNT ON;

    SELECT
        device_id,
        device_name,
        ip_address,
        port,
        t1,
        t2,
        t3,
        k,
        w,
        gi_interval,
        description
    FROM IEC104Devices
    WHERE is_active = 1
    ORDER BY device_id;
END
GO

-- =====================================================
-- SP: Get Active Modbus Devices
-- =====================================================
CREATE OR ALTER PROCEDURE sp_GetActiveModbusDevices
AS
BEGIN
    SET NOCOUNT ON;
    
    SELECT 
        device_id,
        device_name,
        ip_address,
        port,
        unit_id,
        connection_type,
        serial_port,
        baud_rate,
        parity,
        stop_bits,
        data_bits,
        description
    FROM ModbusDevices
    WHERE is_active = 1
    ORDER BY device_id;
END
GO

-- =====================================================
-- SP: Insert Alarm Event
-- =====================================================
CREATE OR ALTER PROCEDURE sp_InsertAlarmEvent
    @alarm_history_id BIGINT = NULL,
    @alarm_type NVARCHAR(20),
    @tag_id INT,
    @tag_name NVARCHAR(100),
    @event_type NVARCHAR(20),
    @event_value FLOAT = NULL,
    @event_user NVARCHAR(100) = NULL,
    @event_comment NVARCHAR(500) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    
    INSERT INTO AlarmEvents (
        alarm_history_id, alarm_type, tag_id, tag_name,
        event_type, event_value, event_user, event_comment, event_timestamp
    )
    VALUES (
        @alarm_history_id, @alarm_type, @tag_id, @tag_name,
        @event_type, @event_value, @event_user, @event_comment, GETDATE()
    );
    
    SELECT SCOPE_IDENTITY() AS event_id;
END
GO

-- =====================================================
-- SP: Trigger Alarm (Create History Record)
-- =====================================================
CREATE OR ALTER PROCEDURE sp_TriggerAlarm
    @alarm_type NVARCHAR(20),
    @tag_id INT,
    @tag_name NVARCHAR(100),
    @alarm_class NVARCHAR(50) = NULL,
    @alarm_number INT = NULL,
    @alarm_text NVARCHAR(200),
    @alarm_severity NVARCHAR(20),
    @trigger_value FLOAT = NULL,
    @limit_value FLOAT = NULL,
    @limit_mode NVARCHAR(20) = NULL,
    @additional_text1 NVARCHAR(500) = NULL,
    @additional_text2 NVARCHAR(500) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    BEGIN TRANSACTION;
    
    BEGIN TRY
        DECLARE @history_id BIGINT;
        DECLARE @now DATETIME2 = GETDATE();
        
        -- Insert alarm history record
        INSERT INTO AlarmHistory (
            alarm_type, tag_id, tag_name, alarm_class, alarm_number,
            alarm_text, alarm_severity, trigger_value, limit_value, limit_mode,
            triggered_at, additional_text1, additional_text2
        )
        VALUES (
            @alarm_type, @tag_id, @tag_name, @alarm_class, @alarm_number,
            @alarm_text, @alarm_severity, @trigger_value, @limit_value, @limit_mode,
            @now, @additional_text1, @additional_text2
        );
        
        SET @history_id = SCOPE_IDENTITY();
        
        -- Update or insert alarm state
        MERGE AlarmStates AS target
        USING (SELECT @alarm_type AS alarm_type, @tag_id AS tag_id) AS source
        ON target.alarm_type = source.alarm_type AND target.tag_id = source.tag_id
        WHEN MATCHED THEN
            UPDATE SET 
                state_code = 1, -- Active
                current_value = @trigger_value,
                triggered_at = @now,
                acknowledged_at = NULL,
                acknowledged_by = NULL,
                ended_at = NULL,
                last_updated = @now
        WHEN NOT MATCHED THEN
            INSERT (alarm_type, tag_id, state_code, current_value, triggered_at, last_updated)
            VALUES (@alarm_type, @tag_id, 1, @trigger_value, @now, @now);
        
        -- Insert event
        INSERT INTO AlarmEvents (
            alarm_history_id, alarm_type, tag_id, tag_name,
            event_type, event_value, event_timestamp
        )
        VALUES (
            @history_id, @alarm_type, @tag_id, @tag_name,
            'TRIGGERED', @trigger_value, @now
        );
        
        COMMIT TRANSACTION;
        SELECT @history_id AS alarm_history_id;
    END TRY
    BEGIN CATCH
        ROLLBACK TRANSACTION;
        THROW;
    END CATCH
END
GO

-- =====================================================
-- SP: End Alarm
-- =====================================================
CREATE OR ALTER PROCEDURE sp_EndAlarm
    @alarm_type NVARCHAR(20),
    @tag_id INT,
    @tag_name NVARCHAR(100),
    @end_value FLOAT = NULL
AS
BEGIN
    SET NOCOUNT ON;
    BEGIN TRANSACTION;
    
    BEGIN TRY
        DECLARE @now DATETIME2 = GETDATE();
        DECLARE @history_id BIGINT;
        DECLARE @triggered_at DATETIME2;
        DECLARE @was_acknowledged BIT = 0;
        
        -- Find the active alarm history record
        SELECT TOP 1 
            @history_id = id,
            @triggered_at = triggered_at,
            @was_acknowledged = CASE WHEN acknowledged_at IS NOT NULL THEN 1 ELSE 0 END
        FROM AlarmHistory
        WHERE alarm_type = @alarm_type 
            AND tag_id = @tag_id 
            AND ended_at IS NULL
        ORDER BY triggered_at DESC;
        
        IF @history_id IS NOT NULL
        BEGIN
            -- Update alarm history
            UPDATE AlarmHistory
            SET 
                ended_at = @now,
                duration_seconds = DATEDIFF(SECOND, @triggered_at, @now)
            WHERE id = @history_id;
            
            -- Update alarm state
            UPDATE AlarmStates
            SET 
                state_code = CASE WHEN @was_acknowledged = 1 THEN 4 ELSE 3 END, -- 4=Ended, 3=InactiveAck (needs ack)
                current_value = @end_value,
                ended_at = @now,
                last_updated = @now
            WHERE alarm_type = @alarm_type AND tag_id = @tag_id;
            
            -- Insert event
            INSERT INTO AlarmEvents (
                alarm_history_id, alarm_type, tag_id, tag_name,
                event_type, event_value, event_timestamp
            )
            VALUES (
                @history_id, @alarm_type, @tag_id, @tag_name,
                'ENDED', @end_value, @now
            );
        END
        
        COMMIT TRANSACTION;
        SELECT @history_id AS alarm_history_id;
    END TRY
    BEGIN CATCH
        ROLLBACK TRANSACTION;
        THROW;
    END CATCH
END
GO

-- =====================================================
-- SP: Acknowledge Alarm
-- =====================================================
CREATE OR ALTER PROCEDURE sp_AcknowledgeAlarm
    @alarm_type NVARCHAR(20),
    @tag_id INT,
    @acknowledged_by NVARCHAR(100),
    @comment NVARCHAR(500) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    BEGIN TRANSACTION;
    
    BEGIN TRY
        DECLARE @now DATETIME2 = GETDATE();
        DECLARE @history_id BIGINT;
        DECLARE @tag_name NVARCHAR(100);
        DECLARE @current_state INT;
        
        -- Get current state
        SELECT @current_state = state_code
        FROM AlarmStates
        WHERE alarm_type = @alarm_type AND tag_id = @tag_id;
        
        -- Find the active alarm history record
        SELECT TOP 1 
            @history_id = id,
            @tag_name = tag_name
        FROM AlarmHistory
        WHERE alarm_type = @alarm_type 
            AND tag_id = @tag_id 
            AND acknowledged_at IS NULL
        ORDER BY triggered_at DESC;
        
        IF @history_id IS NOT NULL
        BEGIN
            -- Update alarm history
            UPDATE AlarmHistory
            SET 
                acknowledged_at = @now,
                acknowledged_by = @acknowledged_by
            WHERE id = @history_id;
            
            -- Update alarm state based on current state
            UPDATE AlarmStates
            SET 
                state_code = CASE 
                    WHEN @current_state = 1 THEN 2  -- Active -> ActiveAck
                    WHEN @current_state = 3 THEN 4  -- InactiveAck -> Ended
                    ELSE state_code 
                END,
                acknowledged_at = @now,
                acknowledged_by = @acknowledged_by,
                last_updated = @now
            WHERE alarm_type = @alarm_type AND tag_id = @tag_id;
            
            -- Insert event
            INSERT INTO AlarmEvents (
                alarm_history_id, alarm_type, tag_id, tag_name,
                event_type, event_user, event_comment, event_timestamp
            )
            VALUES (
                @history_id, @alarm_type, @tag_id, @tag_name,
                'ACKNOWLEDGED', @acknowledged_by, @comment, @now
            );
        END
        
        COMMIT TRANSACTION;
        SELECT @history_id AS alarm_history_id;
    END TRY
    BEGIN CATCH
        ROLLBACK TRANSACTION;
        THROW;
    END CATCH
END
GO

-- =====================================================
-- Create Table Type for Batch Insert (must be before sp_BatchInsertHistorianData)
-- =====================================================
IF NOT EXISTS (SELECT * FROM sys.types WHERE name = 'HistorianDataTableType')
BEGIN
    CREATE TYPE dbo.HistorianDataTableType AS TABLE (
        tag_id      INT             NOT NULL,
        tag_name    NVARCHAR(100)   NOT NULL,
        value       FLOAT           NOT NULL,
        raw_value   FLOAT           NULL,
        quality     INT             NOT NULL,
        timestamp   DATETIME2       NOT NULL
    );
END
GO

-- =====================================================
-- SP: Batch Insert Historian Data
-- =====================================================
CREATE OR ALTER PROCEDURE sp_BatchInsertHistorianData
    @DataTable dbo.HistorianDataTableType READONLY
AS
BEGIN
    SET NOCOUNT ON;
    
    INSERT INTO HistorianData (tag_id, tag_name, value, raw_value, quality, timestamp)
    SELECT tag_id, tag_name, value, raw_value, quality, timestamp
    FROM @DataTable;
    
    SELECT @@ROWCOUNT AS inserted_count;
END
GO

-- =====================================================
-- SP: Get Active Alarms (for WebSocket/API)
-- =====================================================
CREATE OR ALTER PROCEDURE sp_GetActiveAlarms
AS
BEGIN
    SET NOCOUNT ON;
    
    SELECT 
        s.alarm_type,
        s.tag_id,
        COALESCE(a.tag_name, d.tag_name) AS tag_name,
        COALESCE(a.alarm_class, d.alarm_class) AS alarm_class,
        COALESCE(a.alarm_number, d.alarm_number) AS alarm_number,
        COALESCE(a.alarm_text, d.alarm_text) AS alarm_text,
        COALESCE(a.alarm_type, d.alarm_type) AS alarm_severity,
        s.state_code,
        CASE s.state_code
            WHEN 0 THEN 'INACTIVE'
            WHEN 1 THEN 'ACTIVE'
            WHEN 2 THEN 'ACTIVE_ACK'
            WHEN 3 THEN 'INACTIVE_ACK'
            WHEN 4 THEN 'ENDED'
            WHEN 5 THEN 'DISABLED'
        END AS state_name,
        s.current_value,
        s.triggered_at,
        s.acknowledged_at,
        s.acknowledged_by,
        s.ended_at,
        s.last_updated
    FROM AlarmStates s
    LEFT JOIN AnalogAlarmTags a ON s.alarm_type = 'analog' AND s.tag_id = a.id
    LEFT JOIN DiscreteAlarmTags d ON s.alarm_type = 'discrete' AND s.tag_id = d.id
    WHERE s.state_code IN (1, 2, 3) -- Active states only
    ORDER BY s.triggered_at DESC;
END
GO

-- =====================================================
-- SP: Get Alarm History (with pagination)
-- =====================================================
CREATE OR ALTER PROCEDURE sp_GetAlarmHistory
    @page INT = 1,
    @page_size INT = 50,
    @alarm_type NVARCHAR(20) = NULL,
    @alarm_class NVARCHAR(50) = NULL,
    @from_date DATETIME2 = NULL,
    @to_date DATETIME2 = NULL
AS
BEGIN
    SET NOCOUNT ON;
    
    DECLARE @offset INT = (@page - 1) * @page_size;
    
    SELECT 
        id,
        alarm_type,
        tag_id,
        tag_name,
        alarm_class,
        alarm_number,
        alarm_text,
        alarm_severity,
        trigger_value,
        limit_value,
        limit_mode,
        triggered_at,
        acknowledged_at,
        acknowledged_by,
        ended_at,
        duration_seconds,
        additional_text1,
        additional_text2
    FROM AlarmHistory
    WHERE (@alarm_type IS NULL OR alarm_type = @alarm_type)
        AND (@alarm_class IS NULL OR alarm_class = @alarm_class)
        AND (@from_date IS NULL OR triggered_at >= @from_date)
        AND (@to_date IS NULL OR triggered_at <= @to_date)
    ORDER BY triggered_at DESC
    OFFSET @offset ROWS
    FETCH NEXT @page_size ROWS ONLY;
    
    -- Return total count
    SELECT COUNT(*) AS total_count
    FROM AlarmHistory
    WHERE (@alarm_type IS NULL OR alarm_type = @alarm_type)
        AND (@alarm_class IS NULL OR alarm_class = @alarm_class)
        AND (@from_date IS NULL OR triggered_at >= @from_date)
        AND (@to_date IS NULL OR triggered_at <= @to_date);
END
GO

-- =====================================================
-- SP: Get Historian Data (with pagination)
-- =====================================================
CREATE OR ALTER PROCEDURE sp_GetHistorianData
    @tag_id INT = NULL,
    @from_date DATETIME2,
    @to_date DATETIME2,
    @page INT = 1,
    @page_size INT = 1000
AS
BEGIN
    SET NOCOUNT ON;
    
    DECLARE @offset INT = (@page - 1) * @page_size;
    
    SELECT 
        id,
        tag_id,
        tag_name,
        value,
        raw_value,
        quality,
        timestamp
    FROM HistorianData
    WHERE (@tag_id IS NULL OR tag_id = @tag_id)
        AND timestamp >= @from_date
        AND timestamp <= @to_date
    ORDER BY timestamp DESC
    OFFSET @offset ROWS
    FETCH NEXT @page_size ROWS ONLY;
END
GO

-- =====================================================
-- SP: Get Historian Data (Aggregated / Downsampled)
-- Buckets raw samples into fixed time intervals and returns the
-- average (plus min/max) per bucket. Used for long time ranges so
-- the API returns a bounded number of points in a single query
-- instead of fetching millions of raw rows page-by-page.
-- =====================================================
CREATE OR ALTER PROCEDURE sp_GetHistorianDataAggregated
    @tag_id INT = NULL,
    @from_date DATETIME2,
    @to_date DATETIME2,
    @interval_seconds INT = 60,
    @max_points INT = 5000
AS
BEGIN
    SET NOCOUNT ON;

    IF @interval_seconds IS NULL OR @interval_seconds < 1
        SET @interval_seconds = 60;
    IF @max_points IS NULL OR @max_points < 1
        SET @max_points = 5000;

    DECLARE @anchor DATETIME2(0) = '2000-01-01T00:00:00';

    ;WITH bucketed AS (
        SELECT
            DATEADD(
                SECOND,
                CAST((DATEDIFF_BIG(SECOND, @anchor, timestamp) / @interval_seconds) * @interval_seconds AS INT),
                @anchor
            ) AS bucket_time,
            value
        FROM HistorianData
        WHERE (@tag_id IS NULL OR tag_id = @tag_id)
            AND timestamp >= @from_date
            AND timestamp <= @to_date
    )
    SELECT TOP (@max_points)
        bucket_time     AS timestamp,
        AVG(value)      AS value,
        MIN(value)      AS min_value,
        MAX(value)      AS max_value,
        COUNT_BIG(*)    AS sample_count
    FROM bucketed
    GROUP BY bucket_time
    ORDER BY bucket_time ASC;
END
GO

-- =====================================================
-- SP: Insert System Log
-- =====================================================
CREATE OR ALTER PROCEDURE sp_InsertSystemLog
    @log_level NVARCHAR(20),
    @service_name NVARCHAR(50),
    @message NVARCHAR(MAX),
    @error_code NVARCHAR(50) = NULL,
    @stack_trace NVARCHAR(MAX) = NULL,
    @metadata NVARCHAR(MAX) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    
    INSERT INTO SystemLogs (log_level, service_name, message, error_code, stack_trace, metadata)
    VALUES (@log_level, @service_name, @message, @error_code, @stack_trace, @metadata);
END
GO

PRINT '✅ All stored procedures created successfully!';
GO
