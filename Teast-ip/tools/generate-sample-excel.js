const path = require('path');
const ExcelJS = require('exceljs');

const outDir = path.resolve(__dirname, '../excel-data');

const files = [
  {
    name: 'Analog_Alarm_sample.xlsx',
    sheets: {
      Tags: {
        columns: [
          'id',
          'tag_name',
          'protocol_type',
          'iec104_device_id',
          'iec104_asdu_address',
          'iec104_ioa',
          'iec104_type_id',
          'modbus_device_id',
          'register_type',
          'modbus_address',
          'bit_offset',
          'register_count',
          'word_order',
          'data_type',
          'equation',
          'calc',
          'limit_value',
          'limit_mode',
          'alarm_class',
          'alarm_number',
          'alarm_type',
          'alarm_text',
          'alarm_tooltip',
          'additional_text1',
          'additional_text2',
          'consecutive_true_count',
          'consecutive_false_count',
          'chatter_filter_ms',
        ],
        rows: [
          [1, 'Boiler_Pressure_High', 'iec104', 'IEC_RTU_01', 1, 1001, 13, '', '', '', '', 1, 'ABCD', 'real', '', '', 8.5, 'Greater', 'Process', 101, 'alarm', 'Boiler pressure high', 'Check boiler pressure', 'Area A', 'Unit 1', 3, 3, 1000],
          [2, 'Pump_Temp_High', 'modbus', '', '', '', '', 'MB_DEV_01', '4x', 40021, '', 2, 'CDAB', 'real', '', '', 85, 'Greater', 'Process', 102, 'warning', 'Pump temperature high', 'Check pump cooling', 'Area B', 'Pump 2', 3, 3, 1000],
          [3, 'Plant_Load_High', 'internal', '', '', '', '', '', '', '', '', 1, 'ABCD', 'real', '', 'Boiler_Pressure_High + Pump_Temp_High', 100, 'Greater', 'Calculated', 103, 'alarm', 'Plant load high', 'Calculated alarm', 'System', 'Derived', 2, 2, 500],
        ],
      },
    },
  },
  {
    name: 'Discrete_Alarm_sample.xlsx',
    sheets: {
      Tags: {
        columns: [
          'id',
          'tag_name',
          'protocol_type',
          'iec104_device_id',
          'iec104_asdu_address',
          'iec104_ioa',
          'iec104_type_id',
          'modbus_device_id',
          'register_type',
          'modbus_address',
          'bit_offset',
          'register_count',
          'word_order',
          'data_type',
          'equation',
          'calc',
          'limit_mode',
          'alarm_class',
          'alarm_number',
          'alarm_type',
          'alarm_text',
          'alarm_tooltip',
          'consecutive_true_count',
          'consecutive_false_count',
          'chatter_filter_ms',
        ],
        rows: [
          [1, 'Trip_Status', 'iec104', 'IEC_RTU_01', 1, 2001, 1, '', '', '', '', 1, 'ABCD', 'bool', '', '', 'High', 'Protection', 201, 'alarm', 'Trip active', 'Main breaker trip', 2, 2, 500],
          [2, 'Fire_Alarm', 'modbus', '', '', '', '', 'MB_DEV_01', '4x', 40101, 0, 1, 'ABCD', 'bool', '', '', 'High', 'Safety', 202, 'alarm', 'Fire alarm active', 'Check fire panel', 2, 2, 500],
          [3, 'System_Healthy', 'internal', '', '', '', '', '', '', '', '', 1, 'ABCD', 'bool', '', 'Trip_Status * Fire_Alarm', 'Low', 'System', 203, 'warning', 'System unhealthy', 'Derived health signal', 2, 2, 500],
        ],
      },
    },
  },
  {
    name: 'History_sample.xlsx',
    sheets: {
      Tags: {
        columns: [
          'tag_id',
          'tag_name',
          'protocol_type',
          'iec104_device_id',
          'iec104_asdu_address',
          'iec104_ioa',
          'iec104_type_id',
          'modbus_device_id',
          'register_type',
          'modbus_address',
          'bit_offset',
          'register_count',
          'word_order',
          'data_type',
          'equation',
          'calc',
          'description',
          'reading_cycle',
          'reading_cycle_ms',
          'deadband',
          'deadband_check_cycle_s',
        ],
        rows: [
          [1, 'Grid_Voltage', 'iec104', 'IEC_RTU_01', 1, 3001, 13, '', '', '', '', 1, 'ABCD', 'real', '', '', 'Grid voltage from IEC104', '1 sec', 1000, 1, 1],
          [2, 'Inverter_Power', 'modbus', '', '', '', '', 'MB_DEV_01', '4x', 40071, '', 2, 'CDAB', 'real', '', '', 'Inverter active power', '5 sec', 5000, 5, 2],
          [3, 'Plant_Efficiency', 'internal', '', '', '', '', '', '', '', '', 1, 'ABCD', 'real', '', 'Inverter_Power / Grid_Voltage', 'Calculated plant efficiency', '10 sec', 10000, 0, 0],
        ],
      },
    },
  },
];

const sharedSheets = {
  IEC104: {
    columns: ['device_id', 'device_name', 'ip_address', 'port', 't1', 't2', 't3', 'k', 'w', 'gi_interval', 'description'],
    rows: [
      ['IEC_RTU_01', 'Main RTU', '192.168.1.10', 2404, 15, 10, 20, 12, 8, 60, 'Main substation RTU'],
      ['IEC_RTU_02', 'Backup RTU', '192.168.1.11', 2404, 15, 10, 20, 12, 8, 60, 'Backup RTU'],
      ['IEC_LOGGER_01', 'PV Logger', '192.168.1.12', 2404, 15, 10, 20, 12, 8, 120, 'Solar plant logger'],
    ],
  },
  ModbusDevices: {
    columns: ['device_id', 'device_name', 'ip_address', 'port', 'unit_id', 'connection_type', 'serial_port', 'baud_rate', 'parity', 'stop_bits', 'data_bits', 'description'],
    rows: [
      ['MB_DEV_01', 'Inverter 1', '192.168.1.20', 502, 1, 'tcp', '', 9600, 'none', 1, 8, 'Main inverter'],
      ['MB_DEV_02', 'Energy Meter', '192.168.1.21', 502, 2, 'tcp', '', 9600, 'none', 1, 8, 'Feeder meter'],
      ['MB_RTU_01', 'RTU over RS485', '', 502, 3, 'rtu', 'COM3', 9600, 'none', 1, 8, 'Serial Modbus RTU device'],
    ],
  },
};

function addSheet(workbook, name, definition) {
  const ws = workbook.addWorksheet(name);
  ws.addRow(definition.columns);
  definition.rows.forEach((row) => ws.addRow(row));
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.columns.forEach((column, index) => {
    let maxLength = String(definition.columns[index] || '').length;
    ws.eachRow((row) => {
      const value = row.getCell(index + 1).value;
      const cellText = value == null ? '' : String(value);
      if (cellText.length > maxLength) maxLength = cellText.length;
    });
    column.width = Math.min(Math.max(maxLength + 2, 12), 28);
  });
}

async function main() {
  for (const file of files) {
    const workbook = new ExcelJS.Workbook();
    addSheet(workbook, 'Tags', file.sheets.Tags);
    addSheet(workbook, 'IEC104', sharedSheets.IEC104);
    addSheet(workbook, 'ModbusDevices', sharedSheets.ModbusDevices);
    await workbook.xlsx.writeFile(path.join(outDir, file.name));
    console.log(`Created ${file.name}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
