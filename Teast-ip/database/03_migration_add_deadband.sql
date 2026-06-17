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
