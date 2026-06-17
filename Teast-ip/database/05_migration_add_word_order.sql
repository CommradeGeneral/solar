-- =====================================================
-- Migration: Add word_order column (Modbus word/byte order)
-- Purpose: Allow per-tag selection of the Modbus word order for
--          multi-register values (32/64-bit): ABCD / CDAB / BADC / DCBA.
--          NULL = ABCD (big-endian, the previous fixed behavior).
-- Applies to: AnalogAlarmTags, DiscreteAlarmTags, HistorianTags
-- =====================================================

USE IndustrialDB;
GO

-- AnalogAlarmTags ------------------------------------------------
IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME = 'AnalogAlarmTags' AND COLUMN_NAME = 'word_order'
)
BEGIN
    ALTER TABLE AnalogAlarmTags ADD word_order NVARCHAR(10) NULL;
    PRINT 'Column word_order added to AnalogAlarmTags.';
END
ELSE
    PRINT 'Column word_order already exists in AnalogAlarmTags.';
GO

-- DiscreteAlarmTags ----------------------------------------------
IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME = 'DiscreteAlarmTags' AND COLUMN_NAME = 'word_order'
)
BEGIN
    ALTER TABLE DiscreteAlarmTags ADD word_order NVARCHAR(10) NULL;
    PRINT 'Column word_order added to DiscreteAlarmTags.';
END
ELSE
    PRINT 'Column word_order already exists in DiscreteAlarmTags.';
GO

-- HistorianTags --------------------------------------------------
IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME = 'HistorianTags' AND COLUMN_NAME = 'word_order'
)
BEGIN
    ALTER TABLE HistorianTags ADD word_order NVARCHAR(10) NULL;
    PRINT 'Column word_order added to HistorianTags.';
END
ELSE
    PRINT 'Column word_order already exists in HistorianTags.';
GO

PRINT '==============================================';
PRINT 'word_order migration completed.';
PRINT 'Now re-apply database/02_stored_procedures.sql so the';
PRINT 'sp_GetActive* procedures return the new column.';
PRINT '==============================================';
GO
