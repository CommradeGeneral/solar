USE [IndustrialDB];
GO

-- إنشاء الـ View من جديد
CREATE VIEW dbo.v_HistorianData_Local AS
SELECT 
    [tag_id],
    [tag_name],
    [value],
    [raw_value],
    [quality],
    -- السطر ده بيحول التوقيت العالمي (UTC) لتوقيت محلي (مثال: +3 ساعات)
    DATEADD(HOUR, 3, [timestamp]) AS [timestamp_local], 
    [created_at]
FROM [dbo].[HistorianData];
GO