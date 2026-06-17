/**
 * Tool to inspect Excel file structure (sheets + headers + sample rows).
 *
 * Usage:
 *   node tools/inspect-excel.js
 *   node tools/inspect-excel.js excel-data/History.xlsx
 */

const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');

function normalizeCellValue(value) {
    if (value == null) return null;
    if (typeof value === 'object') {
        if (value.text) return value.text;
        if (value.richText) return value.richText.map((p) => p.text).join('');
        if (value.formula != null && value.result != null) return value.result;
        if (value.result != null) return value.result;
    }
    return value;
}

function getHeaders(worksheet) {
    const headerRow = worksheet.getRow(1);
    const values = Array.isArray(headerRow.values) ? headerRow.values.slice(1) : [];
    return values.map((v) => (v != null ? String(normalizeCellValue(v)).trim() : '')).filter((v) => v !== '');
}

async function inspectFile(fullPath, displayPath) {
    console.log(`File: ${displayPath}`);
    if (!fs.existsSync(fullPath)) {
        console.log('  ERR: FILE NOT FOUND\n');
        return;
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(fullPath);

    const sheetCount = Array.isArray(workbook.worksheets) ? workbook.worksheets.length : 0;
    console.log(`  Sheets: ${sheetCount}\n`);

    workbook.eachSheet((worksheet, sheetId) => {
        console.log(`  - Sheet ${sheetId}: "${worksheet.name}"`);

        let rowCount = 0;
        worksheet.eachRow(() => {
            rowCount += 1;
        });
        console.log(`    Rows: ${rowCount}`);

        const headers = getHeaders(worksheet);
        console.log(`    Columns: ${headers.length}`);
        console.log(`    Headers: ${headers.join(' | ') || '(none)'}`);

        console.log('    Sample:');
        let dataRowCount = 0;
        worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
            if (rowNumber === 1) return;
            if (dataRowCount >= 3) return;
            const values = Array.isArray(row.values) ? row.values.slice(1) : [];
            const printable = values.map((v) => normalizeCellValue(v)).map((v) => (v == null ? '' : String(v)));
            console.log(`      Row ${rowNumber}: ${printable.join(' | ')}`);
            dataRowCount += 1;
        });

        if (rowCount > 4) {
            console.log(`      ... and ${rowCount - 4} more rows`);
        }
        console.log('');
    });
}

async function main() {
    const argvPath = process.argv[2];
    const defaultFiles = [
        './excel-data/History.xlsx',
        './excel-data/Analog_Alarm.xlsx',
        './excel-data/Discrete_Alarm.xlsx',
    ];

    const files = argvPath ? [argvPath] : defaultFiles;

    console.log('==============================================');
    console.log('   Excel Files Inspector');
    console.log('==============================================\n');

    for (const filePath of files) {
        const fullPath = path.isAbsolute(filePath)
            ? filePath
            : path.resolve(__dirname, '..', filePath);
        await inspectFile(fullPath, filePath);
        console.log('');
    }

    console.log('Expected sheet names by import-excel.js:');
    console.log('  - Tags (or tags, Sheet1)');
    console.log('  - PLCs (or plcs, PLC)');
    console.log('  - ModbusDevices (or Modbus)');
    console.log('');
}

main().catch((err) => {
    console.error('Error:', err?.message || err);
    process.exitCode = 1;
});

