import ExcelJS from 'exceljs';
import { parseCsvRecords, completedResponsesCsv } from './csv.js';

function excelColumn(index) {
  let result='';
  for(let n=index+1;n>0;n=Math.floor((n-1)/26))result=String.fromCharCode(65+(n-1)%26)+result;
  return result;
}
function nativeTable(nativeCsv) {
  const records=parseCsvRecords(completedResponsesCsv(nativeCsv));
  const headers=records[0].values,labels=records[1].values;
  const finished=headers.findIndex(value=>value.toLowerCase()==='finished');
  let importIds=null;
  try{
    if(typeof JSON.parse(records[2]?.values[finished]??'null')?.ImportId==='string'){
      importIds=records[2].values.map(value=>{try{return String(JSON.parse(value)?.ImportId??'');}catch{return '';}});
    }
  }catch{}
  return {headers,labels,importIds,rows:records.slice(importIds?3:2).map(record=>record.values)};
}
function matchesQuestion(importId,qid) {
  return importId===qid||importId.startsWith(qid+'_')||importId.startsWith(qid+'#');
}
function numericColumn(importId,fieldTypes) {
  const id=String(importId??'');
  return (fieldTypes?.numericQuestionIds??[]).some(qid=>matchesQuestion(id,String(qid)))||
    (/_FILE_SIZE$/i.test(id)&&(fieldTypes?.fileUploadQuestionIds??[]).some(qid=>matchesQuestion(id,String(qid))));
}
function typedValue(value,importId,fieldTypes) {
  if(numericColumn(importId,fieldTypes)&&/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)){
    const number=Number(value);
    const significant=value.replace(/^[+-]/,'').replace('.','').replace(/^0+/,'').length;
    if(Number.isFinite(number)&&significant<=15)return number;
  }
  return value;
}
function addSheet(workbook,name,matrix,{headerRows=1,widths}={}) {
  const width=matrix[0].length;
  const sheet=workbook.addWorksheet(name,{views:[{state:'frozen',ySplit:headerRows,showGridLines:false}],properties:{defaultRowHeight:24}});
  for(const values of matrix){
    if(values.length!==width)throw new Error('Unexpected workbook column count');
    if(values.some(value=>String(value??'').length>32767))throw new Error('An answer exceeds the Excel cell text limit');
    // Excel cell line breaks use LF; normalize Windows CRLF and standalone CR.
    sheet.addRow(values.map(value=>typeof value==='number'?value:String(value??'').replace(/\r\n?/g,'\n')));
  }
  matrix[0].forEach((header,index)=>{sheet.getColumn(index+1).width=widths?.[index]??Math.min(42,Math.max(20,String(header).length+2));});
  sheet.eachRow((row,index)=>{
    row.eachCell({includeEmpty:true},cell=>{
      cell.numFmt=typeof cell.value==='number'?'General':'@';
      cell.font={name:'Arial',size:10};
      cell.alignment={vertical:'top',wrapText:true};
    });
    const lines=Math.max(1,...matrix[index-1].map((value,col)=>Math.max(1,...String(value??'').split(/\r\n|\r|\n/).map(line=>Math.ceil(line.length/Math.max(10,sheet.getColumn(col+1).width-3))))));
    row.height=Math.min(360,Math.max(index===1?42:24,lines*14+8));
    if(index===1)row.eachCell(cell=>{
      cell.font={name:'Arial',size:10,bold:true,color:{argb:'FFFFFFFF'}};
      cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF17324D'}};
    });
    else if(index<=headerRows)row.eachCell({includeEmpty:true},cell=>{
      cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFE7EEF5'}};
      cell.border={bottom:{style:'thin',color:{argb:'FFCBD5E1'}}};
    });
  });
  // Native Qualtrics has duplicate variable names and a second header row.
  // An Excel table or filter would treat that question row as response data.
  if(headerRows===1)sheet.autoFilter={from:{row:1,column:1},to:{row:matrix.length,column:width}};
  return sheet;
}
export async function tableWorkbookBuffer({sheetName='Responses',headers,rows}) {
  const workbook=new ExcelJS.Workbook();workbook.creator='MIT CTL Informal Logistics Initiative';
  addSheet(workbook,sheetName,[headers,...rows]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
export async function surveyWorkbookBuffer(nativeCsv,{sheetName='Sheet0',fieldTypes={}}={}) {
  const table=nativeTable(nativeCsv),workbook=new ExcelJS.Workbook();
  workbook.creator='MIT CTL Informal Logistics Initiative';
  const rows=table.rows.map(row=>row.map((value,index)=>typedValue(value,table.importIds?.[index],fieldTypes)));
  addSheet(workbook,sheetName,[table.headers,table.labels,...rows],{headerRows:2});
  addSheet(workbook,'Data dictionary',[
    ['Column','Excel column','Variable','Question / field','ImportId','Excel type'],
    ...table.headers.map((header,index)=>{
      const kinds=new Set(rows.map(row=>row[index]).filter(value=>value!=='').map(value=>typeof value));
      const type=kinds.has('number')?(kinds.has('string')?'Number / Text':'Number'):(numericColumn(table.importIds?.[index],fieldTypes)&&!kinds.size?'Number':'Text');
      return [index+1,excelColumn(index),header,table.labels[index],table.importIds?.[index]??'',type];
    })
  ],{widths:[10,14,38,85,38,18]});
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
export const XLSX_CONTENT_TYPE='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
