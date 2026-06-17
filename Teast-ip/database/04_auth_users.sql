-- =====================================================
-- Industrial Data Server - Auth (Users + JWT revocation)
-- SQL Server Edition
-- =====================================================

USE IndustrialDB;
GO

-- =====================================================
-- 1) Users
-- =====================================================
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Users')
BEGIN
    CREATE TABLE dbo.Users (
        id              INT IDENTITY(1,1) PRIMARY KEY,
        username        NVARCHAR(50)  NOT NULL UNIQUE,
        password_hash   NVARCHAR(255) NOT NULL,
        role            NVARCHAR(20)  NOT NULL DEFAULT 'viewer', -- administrator | viewer
        is_active       BIT           NOT NULL DEFAULT 1,
        last_login_at   DATETIME2     NULL,
        created_at      DATETIME2     NOT NULL DEFAULT GETDATE(),
        updated_at      DATETIME2     NOT NULL DEFAULT GETDATE()
    );

    CREATE INDEX IX_Users_Active ON dbo.Users(is_active);
END
GO

-- =====================================================
-- 2) Revoked JWTs (logout invalidates tokens immediately)
-- Store JTI until token expiry; cleanup can be done by Retention job if desired.
-- =====================================================
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'RevokedTokens')
BEGIN
    CREATE TABLE dbo.RevokedTokens (
        id              BIGINT IDENTITY(1,1) PRIMARY KEY,
        jti             UNIQUEIDENTIFIER NOT NULL UNIQUE,
        user_id         INT             NULL,
        revoked_at      DATETIME2       NOT NULL DEFAULT GETDATE(),
        expires_at      DATETIME2       NOT NULL,
        reason          NVARCHAR(50)    NULL,

        CONSTRAINT FK_RevokedTokens_User FOREIGN KEY (user_id) REFERENCES dbo.Users(id)
    );

    CREATE INDEX IX_RevokedTokens_Expires ON dbo.RevokedTokens(expires_at);
END
GO

PRINT '✅ Auth tables ensured (Users, RevokedTokens)';
GO

