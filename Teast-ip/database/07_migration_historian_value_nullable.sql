-- =====================================================
-- Migration: Allow NULL in HistorianData.value
-- Purpose: When a device is disconnected, the historian records a NULL value
--          with quality = 0 (Bad) instead of repeating the last good value.
--          This requires the value column to be nullable.
-- =====================================================

USE IndustrialDB;
GO

IF EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME = 'HistorianData'
      AND COLUMN_NAME = 'value'
      AND IS_NULLABLE = 'NO'
)
BEGIN
    ALTER TABLE dbo.HistorianData ALTER COLUMN [value] FLOAT NULL;
    PRINT 'HistorianData.value is now NULLable.';
END
ELSE
    PRINT 'HistorianData.value is already NULLable (no change).';
GO

PRINT '==============================================';
PRINT 'Historian value-nullable migration completed.';
PRINT '==============================================';
GO
